/**
 * El cliente de Graph de la app propia de un cliente. Graph va siempre simulado:
 * acá se afirma qué URL, qué método, qué cabeceras y qué cuerpo sale en cada
 * paso, cómo se lee lo que Meta contesta, que ningún secreto viaja en una URL
 * (salvo `input_token` de `debug_token`, R25, y `appsecret_proof` en la consulta
 * de un GET, Q24) y que ni el token ni el secreto llegan al log. Qué se hace con
 * cada respuesta lo decide el orquestador, no este módulo.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { logger } from "@/lib/observability/logger";
import {
  CAMPOS_DEL_WEBHOOK,
  completarPerfil,
  fijarDatosDeLaApp,
  FORMATO_SECRETO,
  FORMATO_TOKEN,
  GET_LISTA_WHATSAPP,
  leerApp,
  leerDatosDeLaApp,
  leerEstadoDelNombre,
  leerSalud,
  pareceToken,
  pedirNombreNuevo,
  pruebaDelSecreto,
  recortar,
  revisarTokenDeApp,
  suscribirWebhookDeApp,
  type AppDelCliente,
} from "@/server/whatsapp/app-del-cliente";
import type { CredencialDeAlta } from "@/server/whatsapp/alta-de-numero";

const SAVED = { ...process.env };

const APP_ID = "1234567890123";
const SECRETO = "fake-client-app-secret";
const TOKEN = "test-client-system-token-key";
/** HMAC-SHA256 de TOKEN con SECRETO, calculado aparte: fija el algoritmo, no sólo la forma. */
const PRUEBA = "fa6e7a2e5e351bb2b330ab25905e573663c1b96ce5d34ffa9292852a4140e9ef";
const WABA = "300000000000002";
const OTRA_WABA = "300000000000003";
const ID = "300000000000777";
const WABA_PLATAFORMA = "200000000000001";
const ID_PLATAFORMA = "100000000000001";
const USUARIO = "600000000000001";
const BASE = "https://graph.facebook.com/v22.0";
const NUESTRA_URL = "https://example.com/api/webhooks/whatsapp/app/fake-ruta-secreta-0123456789";
const OTRA_URL = "https://example.com/api/webhooks/whatsapp";

const APP: AppDelCliente = { appId: APP_ID, secreto: SECRETO };
const CRED: CredencialDeAlta = { accessToken: TOKEN, wabaId: WABA };
const CRED_CON_PRUEBA: CredencialDeAlta = { ...CRED, prueba: PRUEBA };
const AUTORIZA_APP = { Authorization: `Bearer ${APP_ID}|${SECRETO}` };
const AUTORIZA_CLIENTE = { Authorization: `Bearer ${TOKEN}` };
const AUTORIZA_Y_FORMULARIO = { "Content-Type": "application/x-www-form-urlencoded" };

const respuesta = (cuerpo: unknown, status = 200) => new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { status });

type Llamada = [string, RequestInit];

/** Un fetch que contesta siempre lo mismo; devuelve el mock para mirar las llamadas. */
function graphContesta(cuerpo: unknown, status = 200) {
  const fetchFalso = vi.fn(async () => respuesta(cuerpo, status));
  vi.stubGlobal("fetch", fetchFalso);
  return fetchFalso;
}

/** Un fetch que contesta una cosa distinta por cada llamada, en orden. */
function graphSecuencia(...respuestas: Array<[unknown, number?]>) {
  const fetchFalso = vi.fn();
  for (const [cuerpo, status] of respuestas) fetchFalso.mockImplementationOnce(async () => respuesta(cuerpo, status ?? 200));
  vi.stubGlobal("fetch", fetchFalso);
  return fetchFalso;
}

/** Un fetch que nunca se tendría que llamar. */
function graphProhibido() {
  const fetchFalso = vi.fn(async () => respuesta({ success: true }));
  vi.stubGlobal("fetch", fetchFalso);
  return fetchFalso;
}

function llamadaNumero(fetchFalso: ReturnType<typeof vi.fn>, n: number): { url: string; init: RequestInit } {
  const [url, init] = fetchFalso.mock.calls[n] as unknown as Llamada;
  return { url, init };
}

/** La única llamada que hizo el fetch. */
function unicaLlamada(fetchFalso: ReturnType<typeof vi.fn>) {
  expect(fetchFalso).toHaveBeenCalledTimes(1);
  return llamadaNumero(fetchFalso, 0);
}

const formulario = (init: RequestInit) => Object.fromEntries(new URLSearchParams(init.body as string));
const cuerpoJson = (init: RequestInit) => JSON.parse(init.body as string) as Record<string, unknown>;

const DEBUG_VALIDO = {
  data: {
    app_id: APP_ID,
    is_valid: true,
    expires_at: 0,
    user_id: USUARIO,
    granular_scopes: [
      { scope: "whatsapp_business_management", target_ids: [WABA, OTRA_WABA] },
      { scope: "whatsapp_business_messaging", target_ids: [WABA] },
    ],
  },
};
const conDatos = (cambio: Record<string, unknown>) => ({ data: { ...DEBUG_VALIDO.data, ...cambio } });

let anotado: Array<{ mock: { calls: unknown[][] } }>;

beforeEach(() => {
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

describe("utilidades de formato", () => {
  it("la prueba es el HMAC-SHA256 del token con el secreto, en hexadecimal", () => {
    expect(pruebaDelSecreto(TOKEN, SECRETO)).toBe(PRUEBA);
    expect(pruebaDelSecreto(TOKEN, "fake-otro-secreto")).not.toBe(PRUEBA);
    expect(pruebaDelSecreto("test-otro-token-key", SECRETO)).not.toBe(PRUEBA);
  });

  it("recortar saca sólo el espacio de los bordes", () => {
    expect(recortar("  abc def \n")).toBe("abc def");
  });

  it("pareceToken reconoce un token de acceso y no un secreto", () => {
    expect(pareceToken("EAAGm0PX4ZCpsBA")).toBe(true);
    expect(pareceToken("1234567890123|fake-secret")).toBe(true);
    expect(pareceToken(SECRETO)).toBe(false);
    expect(pareceToken("0123456789abcdef0123456789abcdef")).toBe(false);
  });

  it("el secreto es ASCII visible, de 1 a 128, sin espacios ni controles", () => {
    expect(FORMATO_SECRETO.test(SECRETO)).toBe(true);
    expect(FORMATO_SECRETO.test("a".repeat(128))).toBe(true);
    for (const malo of ["", "a".repeat(129), "con espacio", "tab\taca", "salto\n", "ñandú", " "]) {
      expect(FORMATO_SECRETO.test(malo)).toBe(false);
    }
  });

  it("el token son letras, números y ._-, de 1 a 2048", () => {
    expect(FORMATO_TOKEN.test(TOKEN)).toBe(true);
    expect(FORMATO_TOKEN.test("a".repeat(2048))).toBe(true);
    for (const malo of ["", "a".repeat(2049), "a b", "a/b", "a?b=1", "a|b", "a&b", "a\nb", "a%20b"]) {
      expect(FORMATO_TOKEN.test(malo)).toBe(false);
    }
  });
});

describe("leerApp", () => {
  it("pide GET /{app-id}/subscriptions con el app token en la cabecera y nada más", async () => {
    const fetchFalso = graphContesta({ data: [] });

    await leerApp(APP, NUESTRA_URL);

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${APP_ID}/subscriptions`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(AUTORIZA_APP);
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("con el callback igual al nuestro: nuestro", async () => {
    graphContesta({ data: [{ object: "whatsapp_business_account", callback_url: NUESTRA_URL, active: true, fields: [] }] });
    expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: true, valor: "nuestro" });
  });

  it("con el callback de la plataforma o cualquier otro: ajeno", async () => {
    graphContesta({ data: [{ object: "whatsapp_business_account", callback_url: OTRA_URL }] });
    expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: true, valor: "ajeno" });
  });

  it("la URL se compara entera: un prefijo o una barra de más no es la nuestra", async () => {
    for (const url of [`${NUESTRA_URL}/`, `${NUESTRA_URL}x`, NUESTRA_URL.slice(0, -1), NUESTRA_URL.toUpperCase()]) {
      graphContesta({ data: [{ object: "whatsapp_business_account", callback_url: url }] });
      expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: true, valor: "ajeno" });
    }
  });

  it("si el objeto de WhatsApp no figura, es desconocido (I1: el GET no lista WhatsApp todavía)", async () => {
    expect(GET_LISTA_WHATSAPP).toBe(false);
    graphContesta({ data: [{ object: "user", callback_url: OTRA_URL }, { object: "permissions" }] });
    expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: true, valor: "desconocido" });

    graphContesta({ data: [] });
    expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: true, valor: "desconocido" });
  });

  it("un callback de otro objeto no cuenta como el de WhatsApp", async () => {
    graphContesta({ data: [{ object: "page", callback_url: NUESTRA_URL }] });
    expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: true, valor: "desconocido" });
  });

  it("listado pero sin callback_url: desconocido", async () => {
    for (const fila of [{ object: "whatsapp_business_account" }, { object: "whatsapp_business_account", callback_url: "  " }, { object: "whatsapp_business_account", callback_url: 7 }]) {
      graphContesta({ data: [fila] });
      expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: true, valor: "desconocido" });
    }
  });

  it("un 4xx es rechazo con el código de Meta, y 429 es esperar", async () => {
    graphContesta({ error: { code: 190, message: "Invalid OAuth access token." } }, 400);
    expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: false, falla: "rechazo", codigo: 190 });

    graphContesta({ error: { code: 100 } }, 400);
    expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: false, falla: "rechazo", codigo: 100 });

    graphContesta({ error: { code: 4 } }, 429);
    expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: false, falla: "esperar", codigo: 4 });
  });

  it("un 5xx, un fetch que se cae y una respuesta que no es lo esperado son meta", async () => {
    graphContesta({}, 503);
    expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: false, falla: "meta", codigo: null });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: false, falla: "meta", codigo: null });

    for (const cuerpo of [{}, { data: "x" }, "ok", []]) {
      graphContesta(cuerpo);
      expect(await leerApp(APP, NUESTRA_URL)).toEqual({ ok: false, falla: "meta", codigo: null });
    }
  });

  it.each([
    ["un App ID con letras", { appId: "abc", secreto: SECRETO }],
    ["un App ID con una ruta", { appId: "1234567/../me", secreto: SECRETO }],
    ["un App ID de 5 dígitos", { appId: "12345", secreto: SECRETO }],
    ["un secreto vacío", { appId: APP_ID, secreto: "" }],
    ["un secreto con espacio", { appId: APP_ID, secreto: "fake secret" }],
    ["un secreto con salto de línea", { appId: APP_ID, secreto: "fake-secret\nX-Otra: 1" }],
    ["un secreto de 129 caracteres", { appId: APP_ID, secreto: "a".repeat(129) }],
  ])("%s no sale: rechazo sin código y sin llamar a Graph", async (_caso, app) => {
    const fetchFalso = graphProhibido();
    expect(await leerApp(app, NUESTRA_URL)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("suscribirWebhookDeApp", () => {
  const VERIFY = "fake-verify-token_0123";
  const CAMPOS = [...CAMPOS_DEL_WEBHOOK];

  it("son los cuatro campos que pide el plan", () => {
    expect(CAMPOS).toEqual(["messages", "account_update", "account_review_update", "phone_number_name_update"]);
  });

  it("manda un POST con formulario, el app token y sin consulta en la URL", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await suscribirWebhookDeApp(APP, NUESTRA_URL, VERIFY, CAMPOS)).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${APP_ID}/subscriptions`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ ...AUTORIZA_APP, ...AUTORIZA_Y_FORMULARIO });
    expect(formulario(init)).toEqual({
      object: "whatsapp_business_account",
      callback_url: NUESTRA_URL,
      verify_token: VERIFY,
      fields: "messages,account_update,account_review_update,phone_number_name_update",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sin success: true no está confirmada", async () => {
    for (const cuerpo of [{}, { success: false }, { success: "true" }]) {
      graphContesta(cuerpo);
      expect(await suscribirWebhookDeApp(APP, NUESTRA_URL, VERIFY, CAMPOS)).toEqual({ ok: false, falla: "meta", codigo: null });
    }
  });

  it("el rechazo de Meta (Meta no pudo verificar el callback) vuelve con su código", async () => {
    graphContesta({ error: { code: 2200, message: "callback verification failed" } }, 400);
    expect(await suscribirWebhookDeApp(APP, NUESTRA_URL, VERIFY, CAMPOS)).toEqual({ ok: false, falla: "rechazo", codigo: 2200 });
  });

  it.each([
    ["un callback http", NUESTRA_URL.replace("https:", "http:"), VERIFY, CAMPOS],
    ["un callback con usuario", "https://usuario:clave@example.com/x", VERIFY, CAMPOS],
    ["un callback que no es URL", "no-es-una-url", VERIFY, CAMPOS],
    ["un callback de más de 512 caracteres", `https://example.com/${"a".repeat(500)}`, VERIFY, CAMPOS],
    ["un verify token corto", NUESTRA_URL, "corto", CAMPOS],
    ["un verify token con espacio", NUESTRA_URL, "fake verify token 123", CAMPOS],
    ["un verify token con &", NUESTRA_URL, "fake-verify&fields=x", CAMPOS],
    ["un verify token de 129 caracteres", NUESTRA_URL, "a".repeat(129), CAMPOS],
    ["sin campos", NUESTRA_URL, VERIFY, []],
    ["un campo con mayúsculas", NUESTRA_URL, VERIFY, ["Messages"]],
    ["un campo con coma", NUESTRA_URL, VERIFY, ["messages,otro"]],
  ])("%s no sale", async (_caso, callback, verify, campos) => {
    const fetchFalso = graphProhibido();
    expect(await suscribirWebhookDeApp(APP, callback, verify, campos)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("con una app mal formada no sale", async () => {
    const fetchFalso = graphProhibido();
    expect(await suscribirWebhookDeApp({ appId: "x", secreto: SECRETO }, NUESTRA_URL, VERIFY, CAMPOS)).toMatchObject({ ok: false });
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("leerDatosDeLaApp", () => {
  it("pide los tres campos legales con el app token", async () => {
    const fetchFalso = graphContesta({
      id: APP_ID,
      terms_of_service_url: "https://example.com/terminos",
      privacy_policy_url: "https://example.com/privacidad",
      contact_email: "contacto@example.com",
    });

    const r = await leerDatosDeLaApp(APP);

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${APP_ID}?fields=terms_of_service_url,privacy_policy_url,contact_email`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(AUTORIZA_APP);
    expect(r).toEqual({
      ok: true,
      valor: { terminos: "https://example.com/terminos", privacidad: "https://example.com/privacidad", contacto: "contacto@example.com" },
    });
  });

  it("lo que Meta no trae, o trae vacío, es null", async () => {
    graphContesta({ id: APP_ID, terms_of_service_url: "", privacy_policy_url: "   ", contact_email: 7 });
    expect(await leerDatosDeLaApp(APP)).toEqual({ ok: true, valor: { terminos: null, privacidad: null, contacto: null } });

    graphContesta({ id: APP_ID });
    expect(await leerDatosDeLaApp(APP)).toEqual({ ok: true, valor: { terminos: null, privacidad: null, contacto: null } });
  });

  it("un error del app token vuelve clasificado", async () => {
    graphContesta({ error: { code: 190 } }, 401);
    expect(await leerDatosDeLaApp(APP)).toEqual({ ok: false, falla: "rechazo", codigo: 190 });
  });

  it("con una app mal formada no sale", async () => {
    const fetchFalso = graphProhibido();
    expect(await leerDatosDeLaApp({ appId: APP_ID, secreto: "con espacio" })).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("fijarDatosDeLaApp", () => {
  it("manda sólo los datos que se pasan, con los nombres de campo de Graph", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await fijarDatosDeLaApp(APP, { privacidad: "https://example.com/privacidad" })).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${APP_ID}`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ ...AUTORIZA_APP, ...AUTORIZA_Y_FORMULARIO });
    expect(formulario(init)).toEqual({ privacy_policy_url: "https://example.com/privacidad" });
  });

  it("los tres juntos", async () => {
    const fetchFalso = graphContesta({ success: true });

    await fijarDatosDeLaApp(APP, { terminos: "https://example.com/t", privacidad: "https://example.com/p", contacto: "ayuda@example.com" });

    expect(formulario(unicaLlamada(fetchFalso).init)).toEqual({
      terms_of_service_url: "https://example.com/t",
      privacy_policy_url: "https://example.com/p",
      contact_email: "ayuda@example.com",
    });
  });

  it("sin ningún dato no llama a Graph y da ok", async () => {
    const fetchFalso = graphProhibido();
    expect(await fijarDatosDeLaApp(APP, {})).toEqual({ ok: true, valor: true });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it.each([
    ["términos con http", { terminos: "http://example.com/t" }],
    ["privacidad que no es URL", { privacidad: "mañana" }],
    ["privacidad con usuario", { privacidad: "https://u:p@example.com/p" }],
    ["privacidad de más de 2048", { privacidad: `https://example.com/${"a".repeat(2040)}` }],
    ["contacto sin arroba", { contacto: "ayuda.example.com" }],
    ["contacto con espacio", { contacto: "a b@example.com" }],
    ["un dato bueno y uno malo", { terminos: "https://example.com/t", contacto: "malo" }],
  ])("%s no sale, ni el dato bueno que lo acompaña", async (_caso, datos) => {
    const fetchFalso = graphProhibido();
    expect(await fijarDatosDeLaApp(APP, datos)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("sin success: true no está confirmada", async () => {
    graphContesta({});
    expect(await fijarDatosDeLaApp(APP, { contacto: "ayuda@example.com" })).toEqual({ ok: false, falla: "meta", codigo: null });
  });
});

describe("revisarTokenDeApp", () => {
  it("pide GET debug_token con el token en la consulta y el app token en la cabecera, sin prueba", async () => {
    const fetchFalso = graphContesta(DEBUG_VALIDO);

    await revisarTokenDeApp(TOKEN, APP);

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/debug_token?input_token=${TOKEN}`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(AUTORIZA_APP);
    expect(init.body).toBeUndefined();
    expect(url).not.toContain("appsecret_proof");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("un token bueno: la persona y las WABA que están en los dos permisos", async () => {
    graphContesta(DEBUG_VALIDO);
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: true, usuarioId: USUARIO, wabaIds: [WABA] });
  });

  it("sin user_id, el usuario es null", async () => {
    graphContesta(conDatos({ user_id: undefined }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: true, usuarioId: null, wabaIds: [WABA] });
  });

  it("sin target_ids en ninguno de los dos permisos, wabaIds es null (I3)", async () => {
    graphContesta(
      conDatos({ granular_scopes: [{ scope: "whatsapp_business_management" }, { scope: "whatsapp_business_messaging" }] })
    );
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: true, usuarioId: USUARIO, wabaIds: null });
  });

  it("un permiso sin target_ids no limita: vale la lista del otro", async () => {
    graphContesta(
      conDatos({
        granular_scopes: [
          { scope: "whatsapp_business_management" },
          { scope: "whatsapp_business_messaging", target_ids: [WABA, OTRA_WABA] },
        ],
      })
    );
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: true, usuarioId: USUARIO, wabaIds: [WABA, OTRA_WABA] });
  });

  it("los dos permisos sólo en scopes valen como presentes y dejan wabaIds en null", async () => {
    graphContesta(conDatos({ granular_scopes: undefined, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: true, usuarioId: USUARIO, wabaIds: null });
  });

  it("dos permisos sin WABA en común dan una lista vacía, que decide quien llama", async () => {
    graphContesta(
      conDatos({
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: [WABA] },
          { scope: "whatsapp_business_messaging", target_ids: [OTRA_WABA] },
        ],
      })
    );
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: true, usuarioId: USUARIO, wabaIds: [] });
  });

  it("un target_id que no es un id de Graph se descarta", async () => {
    graphContesta(
      conDatos({
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: [WABA, "../x", 12, "a?b=1"] },
          { scope: "whatsapp_business_messaging", target_ids: [WABA, "../x", 12, "a?b=1"] },
        ],
      })
    );
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: true, usuarioId: USUARIO, wabaIds: [WABA] });
  });

  it("un token que Meta dice inválido: token_vencido", async () => {
    graphContesta(conDatos({ is_valid: false }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "token_vencido" });
  });

  it("un token de otra app: token_de_otra_app", async () => {
    graphContesta(conDatos({ app_id: "999999999" }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "token_de_otra_app" });
  });

  it("sin app_id en la respuesta tampoco es de la app", async () => {
    graphContesta(conDatos({ app_id: undefined }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "token_de_otra_app" });
  });

  it("un token que vence, o sin dato de vencimiento, es token_temporal (I4)", async () => {
    graphContesta(conDatos({ expires_at: 1_800_000_000 }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "token_temporal" });

    graphContesta(conDatos({ expires_at: undefined }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "token_temporal" });
  });

  it("falta uno de los dos permisos: dice cuál", async () => {
    graphContesta(conDatos({ granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA] }] }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "falta_permiso", permiso: "whatsapp_business_messaging" });

    graphContesta(conDatos({ granular_scopes: [{ scope: "whatsapp_business_messaging", target_ids: [WABA] }] }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "falta_permiso", permiso: "whatsapp_business_management" });

    graphContesta(conDatos({ granular_scopes: undefined }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "falta_permiso", permiso: "whatsapp_business_management" });
  });

  it("trae otro permiso de más: permisos_de_mas con la lista (S3), sin repetir los de WhatsApp", async () => {
    graphContesta(
      conDatos({
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: [WABA] },
          { scope: "whatsapp_business_messaging", target_ids: [WABA] },
          { scope: "ads_management", target_ids: [WABA] },
          { scope: "business_management" },
        ],
      })
    );
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({
      ok: false,
      motivo: "permisos_de_mas",
      permisos: ["ads_management", "business_management"],
    });
  });

  it("un permiso de más que sólo figura en scopes también cuenta", async () => {
    graphContesta(conDatos({ scopes: ["whatsapp_business_management", "public_profile"] }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "permisos_de_mas", permisos: ["public_profile"] });
  });

  it("la lista de permisos de más se corta en 20", async () => {
    const muchos = Array.from({ length: 30 }, (_, i) => ({ scope: `permiso_${i}` }));
    graphContesta(conDatos({ granular_scopes: [...DEBUG_VALIDO.data.granular_scopes, ...muchos] }));
    const r = await revisarTokenDeApp(TOKEN, APP);
    expect(r).toMatchObject({ ok: false, motivo: "permisos_de_mas" });
    expect((r as { permisos: string[] }).permisos).toHaveLength(20);
  });

  describe("un 4xx de la propia revisión: se confirma con la app antes de culpar al secreto", () => {
    const LISTA_VACIA = { data: [] };
    const SECRETO_MAL = { error: { code: 190, message: "Invalid OAuth access token signature." } };

    it.each([
      ["190", { error: { code: 190 } }],
      ["102", { error: { code: 102 } }],
      ["100", { error: { code: 100 } }],
      ["un rechazo sin código", {}],
    ])("%s y la app tampoco entra: es app_invalida (secreto cambiado)", async (_nombre, cuerpo) => {
      const fetchFalso = graphSecuencia([cuerpo, 400], [SECRETO_MAL, 400]);
      expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "app_invalida" });
      expect(fetchFalso).toHaveBeenCalledTimes(2);
      // La segunda pregunta es la de la app (suscripciones), con el app token y sin el token del cliente.
      const [url, init] = fetchFalso.mock.calls[1] as Llamada;
      expect(url).toBe(`${BASE}/${APP_ID}/subscriptions`);
      expect(init.headers).toMatchObject(AUTORIZA_APP);
      expect(url).not.toContain(TOKEN);
    });

    it("el 100 con la app que sí entra es el token de otra app («App_id in the input_token did not match the Viewing App»), no el secreto", async () => {
      graphSecuencia([{ error: { code: 100, message: "App_id in the input_token did not match the Viewing App" } }, 400], [LISTA_VACIA, 200]);
      expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "token_de_otra_app" });
    });

    it.each([
      ["190", { error: { code: 190 } }],
      ["102", { error: { code: 102 } }],
      ["un rechazo sin código", {}],
      ["el permiso denegado (10), que sin nombre de permiso no se puede mostrar", { error: { code: 10 } }],
    ])("%s con la app que sí entra no es el secreto: meta, con el código", async (_nombre, cuerpo) => {
      graphSecuencia([cuerpo, 400], [LISTA_VACIA, 200]);
      const r = await revisarTokenDeApp(TOKEN, APP);
      expect(r).toMatchObject({ ok: false, motivo: "meta" });
      expect(r).not.toMatchObject({ motivo: "app_invalida" });
    });

    it("si la app contesta que esperemos o Meta falla, no se afirma nada del secreto", async () => {
      graphSecuencia([{ error: { code: 100 } }, 400], [{ error: { code: 4 } }, 429]);
      expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "esperar", codigo: 4 });
      graphSecuencia([{ error: { code: 100 } }, 400], [{}, 502]);
      expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "meta", codigo: null });
    });

    it("el 190 con subcódigo de token vencido (463, 467) es token_vencido sin preguntarle a la app", async () => {
      const fetchFalso = graphContesta({ error: { code: 190, error_subcode: 463 } }, 400);
      expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "token_vencido" });
      expect(fetchFalso).toHaveBeenCalledTimes(1);
    });

    it("un código de espera con status 400 (17) se pasa como esperar, sin preguntar nada más", async () => {
      const fetchFalso = graphContesta({ error: { code: 17 } }, 400);
      expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "esperar", codigo: 17 });
      expect(fetchFalso).toHaveBeenCalledTimes(1);
    });
  });

  it("un 429 es esperar, y un 5xx o un fetch que se cae es meta", async () => {
    graphContesta({ error: { code: 4 } }, 429);
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "esperar", codigo: 4 });

    graphContesta({}, 502);
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "meta", codigo: null });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "meta", codigo: null });
  });

  it("una respuesta que no dice si es válido es meta", async () => {
    for (const cuerpo of [{}, { data: {} }, { data: { is_valid: "true" } }, { data: [] }, "ok"]) {
      graphContesta(cuerpo);
      expect(await revisarTokenDeApp(TOKEN, APP)).toEqual({ ok: false, motivo: "meta", codigo: null });
    }
  });

  it.each([
    ["un token vacío", ""],
    ["un token con espacio", "test client token"],
    ["un token con ruta", "test-token/../me"],
    ["un token con &", "test-token&access_token=otro"],
    ["un token con salto de línea", "test-token\nX: 1"],
  ])("%s no sale: se rechaza antes de armar la URL", async (_caso, token) => {
    const fetchFalso = graphProhibido();
    expect(await revisarTokenDeApp(token, APP)).toEqual({ ok: false, motivo: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("con una app mal formada no sale", async () => {
    const fetchFalso = graphProhibido();
    expect(await revisarTokenDeApp(TOKEN, { appId: APP_ID, secreto: "" })).toEqual({ ok: false, motivo: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("ni el token ni el secreto llegan al log, venga lo que venga", async () => {
    graphContesta(conDatos({ is_valid: false }));
    await revisarTokenDeApp(TOKEN, APP);
    graphContesta({ error: { code: 190, message: `token ${TOKEN} app ${SECRETO}` } }, 400);
    await revisarTokenDeApp(TOKEN, APP);
    graphContesta({ data: "x" });
    await revisarTokenDeApp(TOKEN, APP);

    const todo = JSON.stringify(anotado.map((s) => s.mock.calls));
    expect(todo).not.toContain(TOKEN);
    expect(todo).not.toContain(SECRETO);
    expect(todo).not.toContain(APP_ID);
  });
});

describe("leerSalud", () => {
  const SALUD = (puede: string, entidades?: unknown) => ({
    health_status: { can_send_message: puede, ...(entidades === undefined ? {} : { entities: entidades }) },
    id: ID,
  });

  it("pide GET /{nodo}?fields=health_status con el token del cliente y sin prueba si no hay", async () => {
    const fetchFalso = graphContesta(SALUD("AVAILABLE"));

    expect(await leerSalud(CRED, ID)).toEqual({ ok: true, valor: { puedeEnviar: "AVAILABLE", motivos: [] } });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}?fields=health_status`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(AUTORIZA_CLIENTE);
    expect(init.body).toBeUndefined();
  });

  it("con prueba la suma a la consulta, no a la cabecera ni al cuerpo", async () => {
    const fetchFalso = graphContesta(SALUD("AVAILABLE"));

    await leerSalud(CRED_CON_PRUEBA, ID);

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}?fields=health_status&appsecret_proof=${PRUEBA}`);
    expect(init.headers).toEqual(AUTORIZA_CLIENTE);
    expect(init.body).toBeUndefined();
  });

  it.each(["AVAILABLE", "LIMITED", "BLOCKED"] as const)("lee %s", async (valor) => {
    graphContesta(SALUD(valor));
    expect(await leerSalud(CRED, WABA)).toEqual({ ok: true, valor: { puedeEnviar: valor, motivos: [] } });
  });

  it("los motivos son los error_code de cada entidad, como texto, sin repetir y sin descripción", async () => {
    graphContesta(
      SALUD("BLOCKED", [
        { entity_type: "WABA", id: WABA, can_send_message: "BLOCKED", errors: [{ error_code: 141006, error_description: "pago pendiente", possible_solution: "pagar" }] },
        { entity_type: "PHONE_NUMBER", id: ID, can_send_message: "BLOCKED", errors: [{ error_code: 141006 }, { error_code: 131031 }, { error_code: "x" }, { error_code: 1.5 }, {}, "raro"] },
        { entity_type: "BUSINESS", id: "1", can_send_message: "AVAILABLE" },
        "raro",
      ])
    );
    const r = await leerSalud(CRED, WABA);
    expect(r).toEqual({ ok: true, valor: { puedeEnviar: "BLOCKED", motivos: ["141006", "131031"] } });
    expect(JSON.stringify(r)).not.toContain("pago pendiente");
  });

  it("los motivos se cortan en 20", async () => {
    const errores = Array.from({ length: 30 }, (_, i) => ({ error_code: 100000 + i }));
    graphContesta(SALUD("BLOCKED", [{ errors: errores }]));
    const r = await leerSalud(CRED, WABA);
    expect(r.ok && r.valor.motivos).toHaveLength(20);
  });

  it("un valor que no es uno de los tres, o sin health_status, es meta", async () => {
    for (const cuerpo of [SALUD("OTRA_COSA"), SALUD(""), { id: ID }, { health_status: [] }, { health_status: { entities: [] } }]) {
      graphContesta(cuerpo);
      expect(await leerSalud(CRED, WABA)).toEqual({ ok: false, falla: "meta", codigo: null });
    }
  });

  it("un token muerto es rechazo con el 190", async () => {
    graphContesta({ error: { code: 190 } }, 401);
    expect(await leerSalud(CRED, WABA)).toEqual({ ok: false, falla: "rechazo", codigo: 190 });
  });

  it.each([
    ["el nodo es el número de la plataforma", CRED, ID_PLATAFORMA],
    ["el nodo es la WABA de la plataforma", CRED, WABA_PLATAFORMA],
    ["el nodo no son dígitos", CRED, "123/../me"],
    ["el nodo es corto", CRED, "123"],
    ["la WABA de la credencial es la de la plataforma", { ...CRED, wabaId: WABA_PLATAFORMA }, ID],
    ["el token tiene un espacio", { ...CRED, accessToken: "test token key" }, ID],
    ["el token está vacío", { ...CRED, accessToken: "" }, ID],
    ["la prueba no es un hexadecimal de 64", { ...CRED, prueba: "abc" }, ID],
    ["la prueba está en mayúsculas", { ...CRED, prueba: PRUEBA.toUpperCase() }, ID],
  ])("no sale cuando %s", async (_caso, cred, nodo) => {
    const fetchFalso = graphProhibido();
    expect(await leerSalud(cred, nodo)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("leerEstadoDelNombre", () => {
  it("pide los tres campos del número con el token del cliente", async () => {
    const fetchFalso = graphContesta({ id: ID, verified_name: "Seguros del Sur", name_status: "APPROVED", new_name_status: "PENDING_REVIEW" });

    const r = await leerEstadoDelNombre(CRED, ID);

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}?fields=verified_name,name_status,new_name_status`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(AUTORIZA_CLIENTE);
    expect(r).toEqual({ ok: true, valor: { nombre: "Seguros del Sur", estado: "APPROVED", estadoNuevo: "PENDING_REVIEW" } });
  });

  it("lo que falta, o viene vacío, es null", async () => {
    graphContesta({ id: ID, verified_name: " ", name_status: 3 });
    expect(await leerEstadoDelNombre(CRED, ID)).toEqual({ ok: true, valor: { nombre: null, estado: null, estadoNuevo: null } });
  });

  it("con prueba la lleva en la consulta", async () => {
    const fetchFalso = graphContesta({ id: ID });
    await leerEstadoDelNombre(CRED_CON_PRUEBA, ID);
    expect(unicaLlamada(fetchFalso).url).toBe(`${BASE}/${ID}?fields=verified_name,name_status,new_name_status&appsecret_proof=${PRUEBA}`);
  });

  it("el número de la plataforma o un id raro no salen", async () => {
    const fetchFalso = graphProhibido();
    expect(await leerEstadoDelNombre(CRED, ID_PLATAFORMA)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(await leerEstadoDelNombre(CRED, "abc")).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("un error de Meta vuelve clasificado", async () => {
    graphContesta({ error: { code: 100 } }, 400);
    expect(await leerEstadoDelNombre(CRED, ID)).toEqual({ ok: false, falla: "rechazo", codigo: 100 });
  });
});

describe("pedirNombreNuevo", () => {
  it("manda POST /{número} con new_display_name en el formulario", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await pedirNombreNuevo(CRED, ID, "  Seguros del Sur  ")).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ ...AUTORIZA_CLIENTE, ...AUTORIZA_Y_FORMULARIO });
    expect(formulario(init)).toEqual({ new_display_name: "Seguros del Sur" });
  });

  it("con prueba va en el cuerpo y no en la URL", async () => {
    const fetchFalso = graphContesta({ success: true });

    await pedirNombreNuevo(CRED_CON_PRUEBA, ID, "Seguros del Sur");

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}`);
    expect(formulario(init)).toEqual({ new_display_name: "Seguros del Sur", appsecret_proof: PRUEBA });
    expect(JSON.stringify(init.headers)).not.toContain(PRUEBA);
  });

  it("un nombre con acentos y símbolos de uso común sale tal cual", async () => {
    const fetchFalso = graphContesta({ success: true });
    await pedirNombreNuevo(CRED, ID, "Peñalba & Hijos S.A. — Seguros");
    expect(formulario(unicaLlamada(fetchFalso).init).new_display_name).toBe("Peñalba & Hijos S.A. — Seguros");
  });

  it.each([
    ["vacío", ""],
    ["sólo blancos", "   "],
    ["con salto de línea", "Seguros\ndel Sur"],
    ["con un carácter de control", "Seguros\u0000del Sur"],
    ["de más de 512", "a".repeat(513)],
  ])("un nombre %s no sale", async (_caso, nombre) => {
    const fetchFalso = graphProhibido();
    expect(await pedirNombreNuevo(CRED, ID, nombre)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("el número de la plataforma no sale", async () => {
    const fetchFalso = graphProhibido();
    expect(await pedirNombreNuevo(CRED, ID_PLATAFORMA, "Seguros del Sur")).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("sin success: true no está confirmado, y un error de Meta vuelve clasificado", async () => {
    graphContesta({});
    expect(await pedirNombreNuevo(CRED, ID, "Seguros del Sur")).toEqual({ ok: false, falla: "meta", codigo: null });

    graphContesta({ error: { code: 133016 } }, 400);
    expect(await pedirNombreNuevo(CRED, ID, "Seguros del Sur")).toEqual({ ok: false, falla: "esperar", codigo: 133016 });
  });
});

describe("completarPerfil", () => {
  const PERFIL_VACIO = { data: [{ messaging_product: "whatsapp" }] };
  const RUTA = `${BASE}/${ID}/whatsapp_business_profile`;

  it("lee el perfil y escribe sólo lo vacío, con messaging_product", async () => {
    const fetchFalso = graphSecuencia([PERFIL_VACIO], [{ success: true }]);

    const r = await completarPerfil(CRED, ID, { email: "ayuda@example.com", vertical: "FINANCE", descripcion: "Seguros" });

    expect(r).toEqual({ ok: true, valor: ["email", "vertical", "descripcion"] });
    expect(fetchFalso).toHaveBeenCalledTimes(2);

    const lectura = llamadaNumero(fetchFalso, 0);
    expect(lectura.url).toBe(`${RUTA}?fields=description,email,vertical`);
    expect(lectura.init.method).toBe("GET");
    expect(lectura.init.headers).toEqual(AUTORIZA_CLIENTE);

    const escritura = llamadaNumero(fetchFalso, 1);
    expect(escritura.url).toBe(RUTA);
    expect(escritura.init.method).toBe("POST");
    expect(escritura.init.headers).toEqual({ ...AUTORIZA_CLIENTE, "Content-Type": "application/json" });
    expect(cuerpoJson(escritura.init)).toEqual({
      messaging_product: "whatsapp",
      email: "ayuda@example.com",
      vertical: "FINANCE",
      description: "Seguros",
    });
  });

  it("no pisa lo que el cliente ya puso", async () => {
    const fetchFalso = graphSecuencia(
      [{ data: [{ email: "propio@example.com", description: "Lo que puso el cliente", vertical: "" }] }],
      [{ success: true }]
    );

    const r = await completarPerfil(CRED, ID, { email: "ayuda@example.com", vertical: "FINANCE", descripcion: "Seguros" });

    expect(r).toEqual({ ok: true, valor: ["vertical"] });
    expect(cuerpoJson(llamadaNumero(fetchFalso, 1).init)).toEqual({ messaging_product: "whatsapp", vertical: "FINANCE" });
  });

  it("si el perfil ya está completo no escribe", async () => {
    const fetchFalso = graphSecuencia([{ data: [{ email: "propio@example.com", vertical: "OTHER" }] }]);

    expect(await completarPerfil(CRED, ID, { email: "ayuda@example.com", vertical: "FINANCE" })).toEqual({ ok: true, valor: [] });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });

  it("sin datos que completar no llama a Graph", async () => {
    const fetchFalso = graphProhibido();
    expect(await completarPerfil(CRED, ID, {})).toEqual({ ok: true, valor: [] });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("con prueba va en la consulta de la lectura y en el cuerpo de la escritura, nunca en la URL de ésta", async () => {
    const fetchFalso = graphSecuencia([PERFIL_VACIO], [{ success: true }]);

    await completarPerfil(CRED_CON_PRUEBA, ID, { email: "ayuda@example.com" });

    const lectura = llamadaNumero(fetchFalso, 0);
    expect(lectura.url).toBe(`${RUTA}?fields=description,email,vertical&appsecret_proof=${PRUEBA}`);
    const escritura = llamadaNumero(fetchFalso, 1);
    expect(escritura.url).toBe(RUTA);
    expect(cuerpoJson(escritura.init)).toEqual({ messaging_product: "whatsapp", email: "ayuda@example.com", appsecret_proof: PRUEBA });
    expect(JSON.stringify(escritura.init.headers)).not.toContain(PRUEBA);
  });

  it("la descripción se recorta en los bordes", async () => {
    const fetchFalso = graphSecuencia([PERFIL_VACIO], [{ success: true }]);
    await completarPerfil(CRED, ID, { descripcion: "  Seguros de auto  " });
    expect(cuerpoJson(llamadaNumero(fetchFalso, 1).init).description).toBe("Seguros de auto");
  });

  it.each([
    ["un correo sin arroba", { email: "ayuda.example.com" }],
    ["una vertical en minúsculas", { vertical: "finance" }],
    ["una vertical con espacio", { vertical: "FINANCE X" }],
    ["una vertical que Meta no ofrece", { vertical: "INSURANCE" }],
    ["una descripción de más de 512", { descripcion: "a".repeat(513) }],
    ["una descripción vacía", { descripcion: "  " }],
    ["una descripción con un carácter de control", { descripcion: "uno\u0007dos" }],
    ["un dato bueno y uno malo", { email: "ayuda@example.com", vertical: "mal" }],
  ])("%s no sale, ni siquiera la lectura", async (_caso, datos) => {
    const fetchFalso = graphProhibido();
    expect(await completarPerfil(CRED, ID, datos)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("el número de la plataforma, o una credencial con la WABA de la plataforma, no salen", async () => {
    const fetchFalso = graphProhibido();
    expect(await completarPerfil(CRED, ID_PLATAFORMA, { email: "ayuda@example.com" })).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(await completarPerfil({ ...CRED, wabaId: WABA_PLATAFORMA }, ID, { email: "ayuda@example.com" })).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("si la lectura falla, vuelve esa falla y no escribe", async () => {
    const fetchFalso = graphSecuencia([{ error: { code: 190 } }, 401]);
    expect(await completarPerfil(CRED, ID, { email: "ayuda@example.com" })).toEqual({ ok: false, falla: "rechazo", codigo: 190 });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });

  it("una lectura sin fila de perfil es meta, y no escribe", async () => {
    for (const cuerpo of [{ data: [] }, { data: "x" }, {}, { data: [7] }]) {
      const fetchFalso = graphSecuencia([cuerpo]);
      expect(await completarPerfil(CRED, ID, { email: "ayuda@example.com" })).toEqual({ ok: false, falla: "meta", codigo: null });
      expect(fetchFalso).toHaveBeenCalledTimes(1);
    }
  });

  it("si la escritura falla o no confirma, vuelve esa falla", async () => {
    graphSecuencia([PERFIL_VACIO], [{ error: { code: 100 } }, 400]);
    expect(await completarPerfil(CRED, ID, { email: "ayuda@example.com" })).toEqual({ ok: false, falla: "rechazo", codigo: 100 });

    graphSecuencia([PERFIL_VACIO], [{}]);
    expect(await completarPerfil(CRED, ID, { email: "ayuda@example.com" })).toEqual({ ok: false, falla: "meta", codigo: null });
  });
});

describe("ningún secreto viaja en una URL ni llega al log", () => {
  /** Cada función, una vez, con respuestas buenas, con la prueba y sin ella. */
  async function todasLasLlamadas() {
    const fetchFalso = vi.fn(async (url: string) => {
      if (url.includes("debug_token")) return respuesta(DEBUG_VALIDO);
      if (url.includes("subscriptions")) return respuesta({ data: [{ object: "whatsapp_business_account", callback_url: OTRA_URL }], success: true });
      if (url.includes("health_status")) return respuesta({ health_status: { can_send_message: "AVAILABLE" } });
      if (url.includes("whatsapp_business_profile")) return respuesta({ data: [{}], success: true });
      if (url.includes("terms_of_service_url")) return respuesta({ id: APP_ID });
      return respuesta({ success: true });
    });
    vi.stubGlobal("fetch", fetchFalso);

    await leerApp(APP, NUESTRA_URL);
    await suscribirWebhookDeApp(APP, NUESTRA_URL, "fake-verify-token_0123", CAMPOS_DEL_WEBHOOK);
    await leerDatosDeLaApp(APP);
    await fijarDatosDeLaApp(APP, { terminos: "https://example.com/t", privacidad: "https://example.com/p", contacto: "ayuda@example.com" });
    await revisarTokenDeApp(TOKEN, APP);
    for (const cred of [CRED, CRED_CON_PRUEBA]) {
      await leerSalud(cred, WABA);
      await leerSalud(cred, ID);
      await leerEstadoDelNombre(cred, ID);
      await pedirNombreNuevo(cred, ID, "Seguros del Sur");
      await completarPerfil(cred, ID, { email: "ayuda@example.com", vertical: "FINANCE", descripcion: "Seguros" });
    }
    return fetchFalso.mock.calls as unknown as Llamada[];
  }

  it("ni el secreto, ni el App ID con el secreto, ni el token en ninguna URL, salvo input_token de debug_token (R25)", async () => {
    const llamadas = await todasLasLlamadas();
    expect(llamadas.length).toBeGreaterThanOrEqual(16);

    for (const [url] of llamadas) {
      expect(url.startsWith(`${BASE}/`)).toBe(true);
      expect(url).not.toContain(SECRETO);
      expect(url).not.toContain(`${APP_ID}|`);
      expect(url).not.toContain(encodeURIComponent(`${APP_ID}|${SECRETO}`));
      if (url.includes("debug_token")) {
        expect(new URL(url).searchParams.get("input_token")).toBe(TOKEN);
        expect([...new URL(url).searchParams.keys()]).toEqual(["input_token"]);
      } else {
        expect(url).not.toContain(TOKEN);
        expect(url).not.toContain("input_token");
        expect(url).not.toContain("access_token");
        expect(url).not.toContain("client_secret");
      }
    }
  });

  it("el appsecret_proof sólo va en la consulta de los GET; en los POST va en el cuerpo, y nunca en una cabecera", async () => {
    const llamadas = await todasLasLlamadas();
    let conPruebaEnConsulta = 0;
    let conPruebaEnCuerpo = 0;

    for (const [url, init] of llamadas) {
      const esPost = init.method === "POST";
      const tieneEnUrl = new URL(url).searchParams.has("appsecret_proof");
      if (esPost) expect(tieneEnUrl).toBe(false);
      if (tieneEnUrl) {
        conPruebaEnConsulta++;
        expect(new URL(url).searchParams.get("appsecret_proof")).toBe(PRUEBA);
      }
      if (typeof init.body === "string" && init.body.includes(PRUEBA)) conPruebaEnCuerpo++;
      expect(JSON.stringify(init.headers)).not.toContain(PRUEBA);
    }
    expect(conPruebaEnConsulta).toBeGreaterThan(0);
    expect(conPruebaEnCuerpo).toBeGreaterThan(0);
  });

  it("las llamadas con el app token no llevan prueba, y las del cliente no llevan el secreto en ningún lado", async () => {
    const llamadas = await todasLasLlamadas();

    for (const [url, init] of llamadas) {
      const cabecera = (init.headers as Record<string, string>).Authorization;
      if (cabecera === `Bearer ${APP_ID}|${SECRETO}`) {
        expect(url).not.toContain("appsecret_proof");
        expect(String(init.body ?? "")).not.toContain("appsecret_proof");
      } else {
        expect(cabecera).toBe(`Bearer ${TOKEN}`);
        expect(String(init.body ?? "")).not.toContain(SECRETO);
      }
    }
  });

  it("ni el token ni el secreto ni la prueba llegan al log, aun con errores que los repiten", async () => {
    const eco = `token ${TOKEN} secreto ${SECRETO} prueba ${PRUEBA} app ${APP_ID}|${SECRETO}`;
    vi.stubGlobal("fetch", vi.fn(async () => respuesta({ error: { code: 190, message: eco, error_data: { details: eco } } }, 400)));

    await leerApp(APP, NUESTRA_URL);
    await suscribirWebhookDeApp(APP, NUESTRA_URL, "fake-verify-token_0123", CAMPOS_DEL_WEBHOOK);
    await leerDatosDeLaApp(APP);
    await fijarDatosDeLaApp(APP, { contacto: "ayuda@example.com" });
    await revisarTokenDeApp(TOKEN, APP);
    await leerSalud(CRED_CON_PRUEBA, WABA);
    await leerEstadoDelNombre(CRED_CON_PRUEBA, ID);
    await pedirNombreNuevo(CRED_CON_PRUEBA, ID, "Seguros del Sur");
    await completarPerfil(CRED_CON_PRUEBA, ID, { email: "ayuda@example.com" });

    const todo = JSON.stringify(anotado.map((s) => s.mock.calls));
    expect(todo).toContain("whatsapp.app_del_cliente.graph");
    for (const secreto of [TOKEN, SECRETO, PRUEBA, APP_ID, "ayuda@example.com"]) expect(todo).not.toContain(secreto);
  });

  it("de un error sólo queda paso, status y código", async () => {
    graphContesta({ error: { code: 100, message: "algo" } }, 400);
    await leerApp(APP, NUESTRA_URL);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ paso: "leer_app", status: 400, codigo: 100 }, "whatsapp.app_del_cliente.graph");
  });
});
