/**
 * El cliente de Graph del alta propia (Embedded Signup). Graph va siempre
 * simulado: acá se afirma qué URL, qué método, qué cabeceras y qué cuerpo salen
 * en cada paso, cómo se lee lo que Meta contesta, que ningún secreto viaja en una
 * URL y que ni el token, ni el código, ni el secreto de la app llegan al log.
 * Qué se hace con cada respuesta está en el orquestador, no acá.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("server-only", () => ({}));

import { CUERPO_REABRIR } from "@/core/mensajes/reabrir-denuncia";
import { logger } from "@/lib/observability/logger";
import {
  appDeMeta,
  bajaDelNumero,
  canjearCodigo,
  codigoVencido,
  crearPlantillaReabrir,
  datosDelNumero,
  desuscribirApp,
  leerDebugToken,
  leerPedidoFirmado,
  negocioDeLaWaba,
  revisarToken,
  suscribirApp,
} from "@/server/whatsapp/embedded-signup";

const SAVED = { ...process.env };

const APP_ID = "1234567890123";
const CONFIG_ID = "9876543210987";
const SECRETO = "fake-app-secret";
const CODIGO = "fake-code-from-popup";
const TOKEN = "fake-client-token-0123456789";
const WABA = "200000000000002";
const OTRA_WABA = "200000000000003";
const WABA_PLATAFORMA = "200000000000001";
const ID = "100000000000777";
const ID_PLATAFORMA = "100000000000001";
const BASE = "https://graph.facebook.com/v22.0";
const SOLO_AUTORIZA = { Authorization: `Bearer ${TOKEN}` };

const respuesta = (cuerpo: unknown, status = 200) =>
  new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { status });

/** Un fetch que contesta siempre lo mismo; devuelve el mock para mirar las llamadas. */
function graphContesta(cuerpo: unknown, status = 200) {
  const fetchFalso = vi.fn(async () => respuesta(cuerpo, status));
  vi.stubGlobal("fetch", fetchFalso);
  return fetchFalso;
}

/** La única llamada que hizo el fetch, con la URL y las opciones a la vista. */
function unicaLlamada(fetchFalso: ReturnType<typeof vi.fn>) {
  expect(fetchFalso).toHaveBeenCalledTimes(1);
  const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init };
}

const formulario = (init: RequestInit) => Object.fromEntries(new URLSearchParams(init.body as string));

const DEBUG_VALIDO = {
  data: {
    app_id: APP_ID,
    is_valid: true,
    expires_at: 0,
    user_id: "600000000000001",
    granular_scopes: [
      { scope: "whatsapp_business_management", target_ids: [WABA, OTRA_WABA] },
      { scope: "whatsapp_business_messaging", target_ids: [WABA] },
    ],
  },
};

let anotado: Array<{ mock: { calls: unknown[][] } }>;

beforeEach(() => {
  process.env.META_APP_ID = APP_ID;
  process.env.META_ES_CONFIG_ID = CONFIG_ID;
  process.env.WHATSAPP_APP_SECRET = SECRETO;
  process.env.WHATSAPP_ACCESS_TOKEN = "fake-platform-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = ID_PLATAFORMA;
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA_PLATAFORMA;
  delete process.env.WHATSAPP_API_VERSION;
  anotado = (["debug", "info", "warn", "error"] as const).map((nivel) => vi.spyOn(logger, nivel).mockImplementation(() => {}));
});

afterEach(() => {
  process.env = { ...SAVED };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("appDeMeta", () => {
  it("devuelve la app y la configuración del popup, y nunca el secreto", () => {
    expect(appDeMeta()).toEqual({ appId: APP_ID, configId: CONFIG_ID });
  });

  it("sin blancos alrededor", () => {
    process.env.META_APP_ID = `  ${APP_ID} `;
    expect(appDeMeta()).toEqual({ appId: APP_ID, configId: CONFIG_ID });
  });

  it.each(["META_APP_ID", "META_ES_CONFIG_ID", "WHATSAPP_APP_SECRET"])("sin %s es null", (variable) => {
    delete process.env[variable];
    expect(appDeMeta()).toBeNull();
    process.env[variable] = "   ";
    expect(appDeMeta()).toBeNull();
  });
});

describe("canjearCodigo", () => {
  it("manda un POST con formulario, sin consulta en la URL ni token en la cabecera", async () => {
    const fetchFalso = graphContesta({ access_token: TOKEN, token_type: "bearer" });

    expect(await canjearCodigo(CODIGO)).toEqual({ ok: true, valor: { token: TOKEN } });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/oauth/access_token`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(formulario(init)).toEqual({ client_id: APP_ID, client_secret: SECRETO, code: CODIGO });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("también entiende la respuesta en texto plano", async () => {
    graphContesta(`${TOKEN}\n`);
    expect(await canjearCodigo(CODIGO)).toEqual({ ok: true, valor: { token: TOKEN } });
  });

  it("un código vencido es un rechazo con el code y el subcódigo de Graph", async () => {
    graphContesta({ error: { message: "This authorization code has expired.", type: "OAuthException", code: 100, error_subcode: 36007 } }, 400);
    expect(await canjearCodigo(CODIGO)).toEqual({ ok: false, falla: "rechazo", codigo: 100, subcodigo: 36007 });
  });

  it("un rechazo sin subcódigo (la app o su secreto mal puestos) llega sin él", async () => {
    graphContesta({ error: { message: "Error validating client secret.", type: "OAuthException", code: 100 } }, 400);
    expect(await canjearCodigo(CODIGO)).toEqual({ ok: false, falla: "rechazo", codigo: 100, subcodigo: null });
  });

  it("429, 5xx y la red caída se separan de un rechazo", async () => {
    graphContesta({ error: { code: 4 } }, 429);
    expect(await canjearCodigo(CODIGO)).toEqual({ ok: false, falla: "esperar", codigo: 4, subcodigo: null });

    graphContesta({}, 502);
    expect(await canjearCodigo(CODIGO)).toEqual({ ok: false, falla: "meta", codigo: null, subcodigo: null });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("red caída"); }));
    expect(await canjearCodigo(CODIGO)).toEqual({ ok: false, falla: "meta", codigo: null, subcodigo: null });
  });

  it("un 200 que no trae un token es «meta»: no se interpreta", async () => {
    for (const cuerpo of [{}, { access_token: "" }, { access_token: 12 }, "", "Internal error ocurrió", "<html>", []]) {
      graphContesta(cuerpo);
      expect(await canjearCodigo(CODIGO)).toEqual({ ok: false, falla: "meta", codigo: null, subcodigo: null });
    }
  });

  it("sin código, con uno de más de 1024 caracteres o sin la app configurada no sale nada", async () => {
    const fetchFalso = graphContesta({ access_token: TOKEN });
    const sin = { ok: false, falla: "rechazo", codigo: null, subcodigo: null };

    expect(await canjearCodigo("")).toEqual(sin);
    expect(await canjearCodigo("x".repeat(1025))).toEqual(sin);
    delete process.env.WHATSAPP_APP_SECRET;
    expect(await canjearCodigo(CODIGO)).toEqual(sin);

    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("de un error queda el paso, el status y el code, y nada del cuerpo ni de lo enviado", async () => {
    graphContesta({ error: { message: `código ${CODIGO} y secreto ${SECRETO}, token ${TOKEN}`, code: 100 } }, 400);

    const r = await canjearCodigo(CODIGO);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ paso: "canje", status: 400, codigo: 100 }, "whatsapp.embedded_signup.graph");
    const todo = JSON.stringify([...anotado.map((s) => s.mock.calls), r]);
    for (const secreto of [CODIGO, SECRETO, TOKEN]) expect(todo).not.toContain(secreto);
  });
});

describe("codigoVencido", () => {
  it.each([36007, 36009])("el código 100 con el subcódigo %s es un código vencido o ya usado", (subcodigo) => {
    expect(codigoVencido({ codigo: 100, subcodigo })).toBe(true);
  });

  it.each([
    [100, null],
    [100, 33],
    [100, 2388],
    [190, 36007],
    [null, 36007],
    [null, null],
  ])("el código %s con el subcódigo %s no lo es: abrir el popup de nuevo no lo arregla", (codigo, subcodigo) => {
    expect(codigoVencido({ codigo, subcodigo })).toBe(false);
  });
});

describe("revisarToken", () => {
  it("manda un POST con el token en el formulario y la app en la cabecera, sin consulta en la URL", async () => {
    const fetchFalso = graphContesta(DEBUG_VALIDO);

    await revisarToken(TOKEN);

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/debug_token`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${APP_ID}|${SECRETO}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(formulario(init)).toEqual({ input_token: TOKEN, method: "GET" });
  });

  it("las WABA son las que están en los dos permisos, y la persona es el user_id", async () => {
    graphContesta(DEBUG_VALIDO);
    expect(await revisarToken(TOKEN)).toEqual({ ok: true, valor: { wabaIds: [WABA], fbUserId: "600000000000001" } });
  });

  it("un target_id que no es un id de Graph se descarta, y sin user_id la persona es null", async () => {
    graphContesta({
      data: {
        ...DEBUG_VALIDO.data,
        user_id: undefined,
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: [WABA, "../x", 12, "a?b=1"] },
          { scope: "whatsapp_business_messaging", target_ids: [WABA, "../x", 12, "a?b=1"] },
        ],
      },
    });
    expect(await revisarToken(TOKEN)).toEqual({ ok: true, valor: { wabaIds: [WABA], fbUserId: null } });
  });

  it("dos permisos sin WABA en común dan una lista vacía, que decide quien llama", async () => {
    graphContesta({
      data: {
        ...DEBUG_VALIDO.data,
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: [WABA] },
          { scope: "whatsapp_business_messaging", target_ids: [OTRA_WABA] },
        ],
      },
    });
    expect(await revisarToken(TOKEN)).toMatchObject({ ok: true, valor: { wabaIds: [] } });
  });

  it("un token que Meta dice inválido es un rechazo con el 190 de un token muerto", async () => {
    graphContesta({ data: { ...DEBUG_VALIDO.data, is_valid: false } });
    expect(await revisarToken(TOKEN)).toEqual({ ok: false, falla: "rechazo", codigo: 190 });
  });

  it.each([
    ["de otra app", { app_id: "999999999" }],
    ["que vence", { expires_at: 1_800_000_000 }],
    ["sin dato de vencimiento", { expires_at: undefined }],
    ["sin el permiso de mensajes", { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA] }] }],
    ["sin el permiso de gestión", { granular_scopes: [{ scope: "whatsapp_business_messaging", target_ids: [WABA] }] }],
    ["sin permisos granulares", { granular_scopes: undefined }],
    ["con otro permiso", { granular_scopes: [{ scope: "ads_management", target_ids: [WABA] }] }],
  ])("un token %s es un rechazo sin código", async (_cual, cambio) => {
    graphContesta({ data: { ...DEBUG_VALIDO.data, ...cambio } });
    expect(await revisarToken(TOKEN)).toEqual({ ok: false, falla: "rechazo", codigo: null });
  });

  it("una respuesta que no dice si es válido es «meta»", async () => {
    for (const cuerpo of [{}, { data: {} }, { data: { is_valid: "true" } }, { data: [] }, "ok"]) {
      graphContesta(cuerpo);
      expect(await revisarToken(TOKEN)).toEqual({ ok: false, falla: "meta", codigo: null });
    }
  });

  it("un 190 de la propia revisión (la credencial de la app) no es un token muerto: sale sin código", async () => {
    graphContesta({ error: { code: 190, message: "Invalid OAuth access token." } }, 400);
    expect(await revisarToken(TOKEN)).toEqual({ ok: false, falla: "rechazo", codigo: null });
  });

  it("sin token o sin la app configurada no sale nada", async () => {
    const fetchFalso = graphContesta(DEBUG_VALIDO);
    expect(await revisarToken("")).toEqual({ ok: false, falla: "rechazo", codigo: null });
    delete process.env.META_APP_ID;
    expect(await revisarToken(TOKEN)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("ni el token ni el secreto llegan al log, venga lo que venga", async () => {
    graphContesta({ data: { ...DEBUG_VALIDO.data, is_valid: false } });
    await revisarToken(TOKEN);
    graphContesta({ error: { code: 190, message: `token ${TOKEN} app ${SECRETO}` } }, 400);
    await revisarToken(TOKEN);

    const todo = JSON.stringify(anotado.map((s) => s.mock.calls));
    expect(todo).not.toContain(TOKEN);
    expect(todo).not.toContain(SECRETO);
  });
});

describe("suscribirApp y desuscribirApp", () => {
  it("suscribir manda POST a subscribed_apps de la WABA, con el token en la cabecera y sin cuerpo", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await suscribirApp(TOKEN, WABA)).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${WABA}/subscribed_apps`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(SOLO_AUTORIZA);
    expect(init.body).toBeUndefined();
  });

  it("desuscribir manda DELETE al mismo recurso", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await desuscribirApp(TOKEN, WABA)).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${WABA}/subscribed_apps`);
    expect(init.method).toBe("DELETE");
    expect(init.headers).toEqual(SOLO_AUTORIZA);
    expect(init.body).toBeUndefined();
  });

  it("un 200 sin success:true es «meta», y un 4xx es un rechazo con su code", async () => {
    for (const funcion of [suscribirApp, desuscribirApp]) {
      graphContesta({ success: false });
      expect(await funcion(TOKEN, WABA)).toEqual({ ok: false, falla: "meta", codigo: null });
      graphContesta({ error: { code: 190 } }, 401);
      expect(await funcion(TOKEN, WABA)).toEqual({ ok: false, falla: "rechazo", codigo: 190 });
    }
  });

  it("una WABA con forma rara, o la de la plataforma, no sale", async () => {
    const fetchFalso = graphContesta({ success: true });
    const sin = { ok: false, falla: "rechazo", codigo: null };

    for (const funcion of [suscribirApp, desuscribirApp]) {
      for (const raro of ["", "abc", "1234", "200000000000002/x", "200000000000002?x=1", "../200000000000002", WABA_PLATAFORMA]) {
        expect(await funcion(TOKEN, raro)).toEqual(sin);
      }
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("datosDelNumero", () => {
  const COMPLETO = {
    display_phone_number: "+54 9 11 0000-0000",
    verified_name: " Seguros Fake ",
    code_verification_status: "VERIFIED",
    name_status: "APPROVED",
    platform_type: "CLOUD_API",
    is_on_biz_app: false,
  };

  it("pide los campos con el token del cliente y los devuelve ya leídos", async () => {
    const fetchFalso = graphContesta(COMPLETO);

    expect(await datosDelNumero(TOKEN, ID)).toEqual({
      ok: true,
      valor: { display: "+54 9 11 0000-0000", nombre: "Seguros Fake", verificado: true, nombreEstado: "APPROVED", enLaApp: false },
    });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(
      `${BASE}/${ID}?fields=display_phone_number,verified_name,code_verification_status,name_status,is_on_biz_app`
    );
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(SOLO_AUTORIZA);
    expect(init.body).toBeUndefined();
  });

  it("si Graph no conoce is_on_biz_app (error 100), se vuelve a pedir sin él y el número se lee igual", async () => {
    const fetchFalso = vi
      .fn()
      .mockResolvedValueOnce(respuesta({ error: { message: "Tried accessing nonexisting field (is_on_biz_app)", code: 100 } }, 400))
      .mockResolvedValueOnce(respuesta(COMPLETO));
    vi.stubGlobal("fetch", fetchFalso);

    expect(await datosDelNumero(TOKEN, ID)).toEqual({
      ok: true,
      valor: { display: "+54 9 11 0000-0000", nombre: "Seguros Fake", verificado: true, nombreEstado: "APPROVED", enLaApp: false },
    });

    expect(fetchFalso).toHaveBeenCalledTimes(2);
    const urls = fetchFalso.mock.calls.map(([url]) => url as string);
    expect(urls[0]).toContain("is_on_biz_app");
    expect(urls[1]).toBe(`${BASE}/${ID}?fields=display_phone_number,verified_name,code_verification_status,name_status`);
  });

  it("otra falla en la primera lectura no se reintenta: la ve quien llama", async () => {
    const fetchFalso = graphContesta({}, 502);

    expect(await datosDelNumero(TOKEN, ID)).toEqual({ ok: false, falla: "meta", codigo: null });

    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });

  it("un número sin verificar, con el nombre sin revisar y en la app de WhatsApp Business", async () => {
    graphContesta({ display_phone_number: "+5491100000000", code_verification_status: "NOT_VERIFIED", is_on_biz_app: true });

    expect(await datosDelNumero(TOKEN, ID)).toEqual({
      ok: true,
      valor: { display: "+5491100000000", nombre: null, verificado: false, nombreEstado: null, enLaApp: true },
    });
  });

  it("sin el número que Graph muestra es «meta»", async () => {
    for (const cuerpo of [{}, { display_phone_number: "  " }, { display_phone_number: 5491100000000 }, []]) {
      graphContesta(cuerpo);
      expect(await datosDelNumero(TOKEN, ID)).toEqual({ ok: false, falla: "meta", codigo: null });
    }
  });

  it("un id con forma rara o el número de la plataforma no sale", async () => {
    const fetchFalso = graphContesta(COMPLETO);
    for (const raro of ["", "abc", "100000000000777/x", "100000000000777?fields=x", ID_PLATAFORMA]) {
      expect(await datosDelNumero(TOKEN, raro)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("negocioDeLaWaba", () => {
  it("pide el negocio dueño de la WABA con el token del cliente y devuelve su id", async () => {
    const fetchFalso = graphContesta({ owner_business_info: { id: "400000000000001", name: "Seguros Fake" }, id: WABA });

    expect(await negocioDeLaWaba(TOKEN, WABA)).toEqual({ ok: true, valor: "400000000000001" });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${WABA}?fields=owner_business_info`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(SOLO_AUTORIZA);
  });

  it.each([{}, { owner_business_info: null }, { owner_business_info: {} }, { owner_business_info: { id: "no-es-un-id" } }, { owner_business_info: { id: 400000000000001 } }])(
    "si Graph no informa un negocio con forma de id (%j), el valor es null y no falla",
    async (cuerpo) => {
      graphContesta(cuerpo);

      expect(await negocioDeLaWaba(TOKEN, WABA)).toEqual({ ok: true, valor: null });
    }
  );

  it("un rechazo de Graph vuelve con su code, y 429 o 5xx se separan", async () => {
    graphContesta({ error: { code: 100 } }, 400);
    expect(await negocioDeLaWaba(TOKEN, WABA)).toEqual({ ok: false, falla: "rechazo", codigo: 100 });

    graphContesta({ error: { code: 4 } }, 429);
    expect(await negocioDeLaWaba(TOKEN, WABA)).toEqual({ ok: false, falla: "esperar", codigo: 4 });

    graphContesta({}, 502);
    expect(await negocioDeLaWaba(TOKEN, WABA)).toEqual({ ok: false, falla: "meta", codigo: null });
  });

  it("una WABA con forma rara, o la de la plataforma, no sale", async () => {
    const fetchFalso = graphContesta({});
    for (const raro of ["", "abc", `${WABA}/x`, `${WABA}?fields=x`, WABA_PLATAFORMA]) {
      expect(await negocioDeLaWaba(TOKEN, raro)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("crearPlantillaReabrir", () => {
  it("manda POST a message_templates con el cuerpo exacto de reabrir_denuncia, de utilidad", async () => {
    const fetchFalso = graphContesta({ id: "700000000000001", status: "PENDING", category: "UTILITY" });

    expect(await crearPlantillaReabrir(TOKEN, WABA)).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${WABA}/message_templates`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ ...SOLO_AUTORIZA, "Content-Type": "application/json" });
    const cuerpo = JSON.parse(init.body as string);
    expect(cuerpo).toEqual({
      name: "reabrir_denuncia",
      language: "es_AR",
      category: "UTILITY",
      components: [{ type: "BODY", text: CUERPO_REABRIR, example: { body_text: [expect.any(Array)] } }],
    });
    // Meta rechaza una plantilla cuyos ejemplos no cubren cada {{n}} del texto.
    const parametros = CUERPO_REABRIR.match(/\{\{\d+\}\}/g) ?? [];
    expect(cuerpo.components[0].example.body_text[0]).toHaveLength(parametros.length);
  });

  it("que ya exista una con ese nombre e idioma cuenta como hecha", async () => {
    graphContesta({ error: { message: "Content in this language already exists", code: 100, error_subcode: 2388024 } }, 400);
    expect(await crearPlantillaReabrir(TOKEN, WABA)).toEqual({ ok: true, valor: true });
  });

  it("cualquier otro rechazo no cuenta, tampoco un 100 sin ese subcódigo", async () => {
    graphContesta({ error: { code: 100, error_subcode: 2388023 } }, 400);
    expect(await crearPlantillaReabrir(TOKEN, WABA)).toEqual({ ok: false, falla: "rechazo", codigo: 100, subcodigo: 2388023 });

    graphContesta({ error: { code: 100 } }, 400);
    expect(await crearPlantillaReabrir(TOKEN, WABA)).toEqual({ ok: false, falla: "rechazo", codigo: 100 });

    graphContesta({ error: { code: 190 } }, 401);
    expect(await crearPlantillaReabrir(TOKEN, WABA)).toEqual({ ok: false, falla: "rechazo", codigo: 190 });
  });

  it("el subcódigo sale con la falla (H11); sin subcódigo, la falla no lo trae", async () => {
    graphContesta({ error: { code: 100, error_subcode: 2388023 } }, 400);
    expect(Object.keys(await crearPlantillaReabrir(TOKEN, WABA)).sort()).toEqual(["codigo", "falla", "ok", "subcodigo"]);

    graphContesta({ error: { code: 100 } }, 400);
    expect(Object.keys(await crearPlantillaReabrir(TOKEN, WABA)).sort()).toEqual(["codigo", "falla", "ok"]);
  });

  it("un 200 sin id es «meta»", async () => {
    graphContesta({ status: "PENDING" });
    expect(await crearPlantillaReabrir(TOKEN, WABA)).toEqual({ ok: false, falla: "meta", codigo: null });
  });

  it("una WABA con forma rara, o la de la plataforma, no sale", async () => {
    const fetchFalso = graphContesta({ id: "7" });
    for (const raro of ["", "abc", "200000000000002/x", WABA_PLATAFORMA]) {
      expect(await crearPlantillaReabrir(TOKEN, raro)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("bajaDelNumero", () => {
  it("manda POST a deregister del número, con el token en la cabecera y sin cuerpo", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await bajaDelNumero(TOKEN, ID)).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}/deregister`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(SOLO_AUTORIZA);
    expect(init.body).toBeUndefined();
  });

  it("un 200 sin success:true es «meta», y un 4xx es un rechazo con su code", async () => {
    graphContesta({ success: false });
    expect(await bajaDelNumero(TOKEN, ID)).toEqual({ ok: false, falla: "meta", codigo: null });
    graphContesta({ error: { code: 133016 } }, 400);
    expect(await bajaDelNumero(TOKEN, ID)).toEqual({ ok: false, falla: "esperar", codigo: 133016 });
  });

  it("nunca da de baja el número de la plataforma ni un id con forma rara", async () => {
    const fetchFalso = graphContesta({ success: true });
    for (const raro of ["", "abc", "100000000000777/x", ID_PLATAFORMA]) {
      expect(await bajaDelNumero(TOKEN, raro)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("ningún secreto viaja en una URL", () => {
  it("ni el código, ni el secreto de la app, ni el token del cliente, en ninguno de los pedidos", async () => {
    const fetchFalso = vi.fn(async (url: string) => {
      if (url.includes("oauth/access_token")) return respuesta({ access_token: TOKEN });
      if (url.includes("debug_token")) return respuesta(DEBUG_VALIDO);
      if (url.includes(`${ID}?`)) return respuesta({ display_phone_number: "+5491100000000" });
      if (url.includes("message_templates")) return respuesta({ id: "7" });
      return respuesta({ success: true });
    });
    vi.stubGlobal("fetch", fetchFalso);

    await canjearCodigo(CODIGO);
    await revisarToken(TOKEN);
    await suscribirApp(TOKEN, WABA);
    await desuscribirApp(TOKEN, WABA);
    await datosDelNumero(TOKEN, ID);
    await crearPlantillaReabrir(TOKEN, WABA);
    await bajaDelNumero(TOKEN, ID);

    const llamadas = fetchFalso.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(llamadas).toHaveLength(7);
    for (const [url] of llamadas) {
      for (const secreto of [CODIGO, SECRETO, TOKEN, APP_ID, "client_secret", "input_token", "access_token="]) {
        expect(url).not.toContain(secreto);
      }
      // El único pedido con consulta es la lectura de campos del número, que no lleva más que `fields`.
      const consulta = new URL(url).searchParams;
      if (consulta.size > 0) expect([...consulta.keys()]).toEqual(["fields"]);
    }
  });

  it("los dos que llevan un secreto en el cuerpo lo llevan como formulario y ningún pedido tiene token en la cabecera de otro", async () => {
    const fetchFalso = vi.fn(async (url: string) => respuesta(url.includes("debug_token") ? DEBUG_VALIDO : { access_token: TOKEN }));
    vi.stubGlobal("fetch", fetchFalso);

    await canjearCodigo(CODIGO);
    await revisarToken(TOKEN);

    const [canje, revision] = fetchFalso.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(new URLSearchParams(canje[1].body as string).get("client_secret")).toBe(SECRETO);
    expect(new URLSearchParams(revision[1].body as string).get("input_token")).toBe(TOKEN);
    expect(JSON.stringify(canje[1].headers)).not.toMatch(new RegExp(`${SECRETO}|${CODIGO}`));
    expect(JSON.stringify(revision[1].headers)).not.toContain(TOKEN);
  });
});

describe("leerPedidoFirmado", () => {
  const codificar = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const firmar = (payload: string, secreto = SECRETO) => createHmac("sha256", secreto).update(payload).digest().toString("base64url");
  function pedido(carga: unknown, secreto = SECRETO): string {
    const payload = codificar(carga);
    return `${firmar(payload, secreto)}.${payload}`;
  }
  const CARGA = { algorithm: "HMAC-SHA256", issued_at: 1_760_000_000, user_id: "600000000000001" };

  it("devuelve la persona de un pedido bien firmado", () => {
    expect(leerPedidoFirmado(pedido(CARGA))).toEqual({ userId: "600000000000001" });
  });

  it("acepta el algoritmo en cualquier capitalización", () => {
    expect(leerPedidoFirmado(pedido({ ...CARGA, algorithm: "hmac-sha256" }))).toEqual({ userId: "600000000000001" });
  });

  it("una firma hecha con otro secreto, o un payload cambiado después de firmar, es null", () => {
    expect(leerPedidoFirmado(pedido(CARGA, "otro-secreto"))).toBeNull();

    const [firma] = pedido(CARGA).split(".");
    expect(leerPedidoFirmado(`${firma}.${codificar({ ...CARGA, user_id: "600000000000002" })}`)).toBeNull();
  });

  it("un algoritmo que no es HMAC-SHA256 es null, aunque la firma sea buena", () => {
    expect(leerPedidoFirmado(pedido({ ...CARGA, algorithm: "none" }))).toBeNull();
    expect(leerPedidoFirmado(pedido({ ...CARGA, algorithm: undefined }))).toBeNull();
  });

  it("un user_id que no son dígitos, o que no está, es null", () => {
    for (const user_id of ["../x", "", "abc", 600000000000001, null, undefined]) {
      expect(leerPedidoFirmado(pedido({ ...CARGA, user_id }))).toBeNull();
    }
  });

  it("lo que no tiene forma de signed_request es null, sin tirar", () => {
    const payload = codificar(CARGA);
    for (const roto of ["", "x", ".", "a.", `.${payload}`, `a.b.c`, `${firmar(payload)}.${payload}.x`, `${firmar(payload).slice(0, 10)}.${payload}`]) {
      expect(leerPedidoFirmado(roto)).toBeNull();
    }
    const noJson = Buffer.from("no es json").toString("base64url");
    expect(leerPedidoFirmado(`${firmar(noJson)}.${noJson}`)).toBeNull();
    expect(leerPedidoFirmado(undefined as unknown as string)).toBeNull();
  });

  it("sin el secreto de la app no valida nada", () => {
    const firmado = pedido(CARGA);
    delete process.env.WHATSAPP_APP_SECRET;
    expect(leerPedidoFirmado(firmado)).toBeNull();
  });
});

describe("leerDebugToken", () => {
  const dato = (cambio: Record<string, unknown> = {}) => ({ data: { ...DEBUG_VALIDO.data, ...cambio } });

  it("lee lo que Meta dice sin decidir nada: validez, app, persona, vencimiento y alcances", () => {
    const lectura = leerDebugToken(DEBUG_VALIDO, APP_ID);

    expect(lectura).toEqual({
      valido: true,
      appId: APP_ID,
      deLaApp: true,
      usuarioId: "600000000000001",
      expira: 0,
      alcances: new Map([
        ["whatsapp_business_management", [WABA, OTRA_WABA]],
        ["whatsapp_business_messaging", [WABA]],
      ]),
    });
  });

  it("deLaApp compara el app_id de la respuesta con la app que se pasó, no con la de la plataforma", () => {
    expect(leerDebugToken(dato({ app_id: "999999999" }), APP_ID)).toMatchObject({ appId: "999999999", deLaApp: false });
    expect(leerDebugToken(dato({ app_id: "999999999" }), "999999999")).toMatchObject({ deLaApp: true });
    expect(leerDebugToken(DEBUG_VALIDO, "999999999")).toMatchObject({ appId: APP_ID, deLaApp: false });
  });

  it("un app_id que no vino como texto no es de ninguna app", () => {
    for (const app_id of [undefined, 1234567890123, null, ""]) {
      expect(leerDebugToken(dato({ app_id }), APP_ID)).toMatchObject({ appId: null, deLaApp: false });
    }
  });

  it("un token inválido se lee igual: quien llama decide qué hacer con eso", () => {
    expect(leerDebugToken(dato({ is_valid: false }), APP_ID)).toMatchObject({ valido: false });
  });

  it("sin data.is_valid booleano es null: una respuesta que no se interpreta", () => {
    for (const cuerpo of [null, undefined, "ok", 7, [], {}, { data: {} }, { data: [] }, { data: { is_valid: "true" } }, { data: { is_valid: 1 } }]) {
      expect(leerDebugToken(cuerpo, APP_ID)).toBeNull();
    }
  });

  it("expires_at: 0 es un token sin vencimiento, un número es su vencimiento y lo demás es null", () => {
    expect(leerDebugToken(dato({ expires_at: 0 }), APP_ID)?.expira).toBe(0);
    expect(leerDebugToken(dato({ expires_at: 1_800_000_000 }), APP_ID)?.expira).toBe(1_800_000_000);
    for (const expires_at of [undefined, "0", null]) expect(leerDebugToken(dato({ expires_at }), APP_ID)?.expira).toBeNull();
  });

  it("user_id es el usuario del sistema, sin blancos, o null", () => {
    expect(leerDebugToken(dato({ user_id: " 600000000000001 " }), APP_ID)?.usuarioId).toBe("600000000000001");
    for (const user_id of [undefined, null, 600000000000001, "  "]) expect(leerDebugToken(dato({ user_id }), APP_ID)?.usuarioId).toBeNull();
  });

  it("un target_id que no es un id de Graph se descarta, sin tirar el permiso", () => {
    const lectura = leerDebugToken(
      dato({ granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA, "../x", 12, "a?b=1", null, "12"] }] }),
      APP_ID
    );
    expect(lectura?.alcances.get("whatsapp_business_management")).toEqual([WABA]);
  });

  it("sin target_ids el permiso queda en null: vale para todos los activos y no se inventa una lista", () => {
    const lectura = leerDebugToken(
      dato({ granular_scopes: [{ scope: "whatsapp_business_management" }, { scope: "whatsapp_business_messaging", target_ids: "no-es-lista" }] }),
      APP_ID
    );
    expect(lectura?.alcances.get("whatsapp_business_management")).toBeNull();
    expect(lectura?.alcances.get("whatsapp_business_messaging")).toBeNull();
  });

  it("un target_ids vacío es una lista vacía, no un null", () => {
    const lectura = leerDebugToken(dato({ granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [] }] }), APP_ID);
    expect(lectura?.alcances.get("whatsapp_business_management")).toEqual([]);
  });

  it("un permiso que sólo figura en scopes entra como null y nunca pisa a uno granular", () => {
    const lectura = leerDebugToken(
      dato({
        granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA] }],
        scopes: ["whatsapp_business_management", "whatsapp_business_messaging", "business_management", 7, "  "],
      }),
      APP_ID
    );
    expect(lectura?.alcances).toEqual(
      new Map<string, string[] | null>([
        ["whatsapp_business_management", [WABA]],
        ["whatsapp_business_messaging", null],
        ["business_management", null],
      ])
    );
  });

  it("entradas de granular_scopes sin permiso, o que no son objetos, se saltean", () => {
    const lectura = leerDebugToken(dato({ granular_scopes: [null, 3, "x", {}, { scope: "" }, { scope: 5 }, { scope: "ads_read", target_ids: [WABA] }] }), APP_ID);
    expect([...(lectura?.alcances.keys() ?? [])]).toEqual(["ads_read"]);
  });

  it("sin granular_scopes ni scopes los alcances son un mapa vacío", () => {
    expect(leerDebugToken(dato({ granular_scopes: undefined, scopes: undefined }), APP_ID)?.alcances.size).toBe(0);
    expect(leerDebugToken(dato({ granular_scopes: "no", scopes: {} }), APP_ID)?.alcances.size).toBe(0);
  });

  it("no toca el cuerpo que recibe", () => {
    const entrada = JSON.parse(JSON.stringify(DEBUG_VALIDO));
    leerDebugToken(entrada, APP_ID);
    expect(entrada).toEqual(DEBUG_VALIDO);
  });
});

describe("el appsecret_proof de la app propia (R5)", () => {
  const PRUEBA = "a".repeat(64);

  /** Cada función que el alta reusa para la app propia, llamada con la prueba a lo último. */
  const reusadas: Array<[string, (p?: string) => Promise<unknown>, string]> = [
    ["suscribirApp", (p) => suscribirApp(TOKEN, WABA, p), `${BASE}/${WABA}/subscribed_apps`],
    ["desuscribirApp", (p) => desuscribirApp(TOKEN, WABA, p), `${BASE}/${WABA}/subscribed_apps`],
    ["crearPlantillaReabrir", (p) => crearPlantillaReabrir(TOKEN, WABA, p), `${BASE}/${WABA}/message_templates`],
    ["bajaDelNumero", (p) => bajaDelNumero(TOKEN, ID, p), `${BASE}/${ID}/deregister`],
  ];

  it.each(reusadas)("%s sin prueba no suma nada a la URL: Embedded Signup sigue igual", async (_nombre, llamar, destino) => {
    const fetchFalso = graphContesta({ success: true, id: "7" });

    await llamar();

    expect(unicaLlamada(fetchFalso).url).toBe(destino);
  });

  it.each(reusadas)("%s con prueba la manda en el cuerpo si es POST y en la consulta si es DELETE (Q24), y el token sigue sólo en la cabecera", async (_nombre, llamar, destino) => {
    const fetchFalso = graphContesta({ success: true, id: "7" });

    await llamar(PRUEBA);

    const { url, init } = unicaLlamada(fetchFalso);
    if (init.method === "POST") {
      expect(url).toBe(destino);
      const cuerpo = init.body as string;
      expect(cuerpo.startsWith("{") ? JSON.parse(cuerpo).appsecret_proof : new URLSearchParams(cuerpo).get("appsecret_proof")).toBe(PRUEBA);
    } else {
      expect(url).toBe(`${destino}?appsecret_proof=${PRUEBA}`);
      expect(init.body).toBeUndefined();
    }
    expect(url).not.toContain(TOKEN);
    expect(JSON.stringify(init.headers)).not.toContain(PRUEBA);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("un POST sin cuerpo propio con prueba manda un formulario con sólo la prueba; sin prueba sigue sin cuerpo", async () => {
    const con = graphContesta({ success: true });
    await suscribirApp(TOKEN, WABA, PRUEBA);
    const { init } = unicaLlamada(con);
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" });
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({ appsecret_proof: PRUEBA });

    const sin = graphContesta({ success: true });
    await suscribirApp(TOKEN, WABA);
    expect(unicaLlamada(sin).init.body).toBeUndefined();
  });

  it("datosDelNumero suma la prueba tras los campos con &, en la primera lectura y en la segunda sin is_on_biz_app", async () => {
    const fetchFalso = vi.fn(async (url: string) =>
      url.includes("is_on_biz_app") ? respuesta({ error: { code: 100 } }, 400) : respuesta({ display_phone_number: "+5491100000000" })
    );
    vi.stubGlobal("fetch", fetchFalso);

    await datosDelNumero(TOKEN, ID, PRUEBA);

    const urls = (fetchFalso.mock.calls as unknown as Array<[string]>).map(([u]) => u);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url.startsWith(`${BASE}/${ID}?fields=`)).toBe(true);
      expect(url.endsWith(`&appsecret_proof=${PRUEBA}`)).toBe(true);
      expect(new URL(url).searchParams.get("appsecret_proof")).toBe(PRUEBA);
      expect(url).not.toContain(TOKEN);
    }
  });

  it("datosDelNumero sin prueba sigue pidiendo sólo los campos", async () => {
    const fetchFalso = graphContesta({ display_phone_number: "+5491100000000" });

    await datosDelNumero(TOKEN, ID);

    expect([...new URL(unicaLlamada(fetchFalso).url).searchParams.keys()]).toEqual(["fields"]);
  });

  it("la prueba no cambia el método ni la autorización de un pedido", async () => {
    const conPrueba = graphContesta({ success: true });
    await suscribirApp(TOKEN, WABA, PRUEBA);
    const sin = graphContesta({ success: true });
    await suscribirApp(TOKEN, WABA);

    const a = unicaLlamada(conPrueba).init;
    const b = unicaLlamada(sin).init;
    expect(a.method).toBe(b.method);
    expect((a.headers as Record<string, string>).Authorization).toBe((b.headers as Record<string, string>).Authorization);
  });

  it("el cuerpo de la plantilla es el de siempre más la prueba", async () => {
    const fetchFalso = graphContesta({ id: "7" });
    await crearPlantillaReabrir(TOKEN, WABA);
    const sin = JSON.parse(unicaLlamada(fetchFalso).init.body as string);

    const conPrueba = graphContesta({ id: "7" });
    await crearPlantillaReabrir(TOKEN, WABA, PRUEBA);
    const cuerpo = JSON.parse(unicaLlamada(conPrueba).init.body as string);

    expect(cuerpo).toEqual({ ...sin, appsecret_proof: PRUEBA });
    expect(cuerpo.name).toBe("reabrir_denuncia");
  });

  it("una WABA o un número con forma rara siguen sin salir aunque haya prueba", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await suscribirApp(TOKEN, "../x", PRUEBA)).toMatchObject({ ok: false });
    expect(await bajaDelNumero(TOKEN, ID_PLATAFORMA, PRUEBA)).toMatchObject({ ok: false });
    expect(await suscribirApp(TOKEN, WABA_PLATAFORMA, PRUEBA)).toMatchObject({ ok: false });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("la prueba no llega al log de una falla", async () => {
    graphContesta({ error: { code: 190, message: `proof ${PRUEBA} token ${TOKEN}` } }, 400);
    await suscribirApp(TOKEN, WABA, PRUEBA);

    const todo = JSON.stringify(anotado.map((s) => s.mock.calls));
    expect(todo).not.toContain(PRUEBA);
    expect(todo).not.toContain(TOKEN);
  });

  it("revisarToken y canjearCodigo, que usan la credencial de la app, no llevan prueba en la URL", async () => {
    const fetchFalso = vi.fn(async (url: string) => respuesta(url.includes("debug_token") ? DEBUG_VALIDO : { access_token: TOKEN }));
    vi.stubGlobal("fetch", fetchFalso);

    await canjearCodigo(CODIGO);
    await revisarToken(TOKEN);

    for (const [url] of fetchFalso.mock.calls as unknown as Array<[string]>) expect(url).not.toContain("appsecret_proof");
  });
});
