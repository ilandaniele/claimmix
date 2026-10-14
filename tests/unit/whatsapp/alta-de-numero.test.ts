/**
 * El cliente de Graph que suma un número a la WABA. Graph va siempre simulado:
 * acá se afirma qué URL, qué método, qué cabeceras y qué cuerpo salen en cada
 * paso, cómo se lee lo que Meta contesta y que ni el PIN, ni el código, ni el
 * token, ni lo que dice Graph llegan al log. Quién puede pedirlo y qué se guarda
 * está en `tests/unit/alta/numero-automatico.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { randomIntFalso } = vi.hoisted(() => ({ randomIntFalso: vi.fn(() => 42) }));
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, randomInt: randomIntFalso, default: { ...real, randomInt: randomIntFalso } };
});

import { ID_DE_META } from "@/lib/meta-ids";
import { logger } from "@/lib/observability/logger";
import {
  agregarNumero,
  clasificar,
  codigoYaVerificado,
  fijarWebhookDelNumero,
  numeroYaRegistrado,
  partirNumero,
  pedirCodigoAMeta,
  registrarNumero,
  verificarCodigoEnMeta,
  webhookPropioEs,
  type CredencialDeAlta,
} from "@/server/whatsapp/alta-de-numero";

const SAVED = { ...process.env };

const WABA = "200000000000001";
const ID = "100000000000777";
const PLATAFORMA = "100000000000001";
const CRED: CredencialDeAlta = { accessToken: "fake-access-token", wabaId: WABA };
const BASE = "https://graph.facebook.com/v22.0";
const CON_CUERPO = { Authorization: "Bearer fake-access-token", "Content-Type": "application/json" };
const SIN_CUERPO = { Authorization: "Bearer fake-access-token" };
const WEBHOOK = { url: "https://claimmix.example.com/api/webhooks/whatsapp", verifyToken: "fake-verify-token" };

const respuesta = (cuerpo: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo }) as Response;

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

let anotado: Array<{ mock: { calls: unknown[][] } }>;

beforeEach(() => {
  process.env.WHATSAPP_ACCESS_TOKEN = "fake-access-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = PLATAFORMA;
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA;
  delete process.env.WHATSAPP_API_VERSION;
  randomIntFalso.mockReset();
  randomIntFalso.mockImplementation(() => 42);
  anotado = (["debug", "info", "warn", "error"] as const).map((nivel) => vi.spyOn(logger, nivel).mockImplementation(() => {}));
});

afterEach(() => {
  process.env = { ...SAVED };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("agregarNumero", () => {
  it("manda POST a la WABA con el país, el número y el nombre, y devuelve el id de Graph", async () => {
    const fetchFalso = graphContesta({ id: ID });

    const r = await agregarNumero(CRED, { cc: "54", numero: "92915550000" }, "Veltra");

    expect(r).toEqual({ ok: true, valor: ID });
    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${WABA}/phone_numbers`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(CON_CUERPO);
    expect(JSON.parse(init.body as string)).toEqual({ cc: "54", phone_number: "92915550000", verified_name: "Veltra" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("un id que no son dígitos, o que no viene, es «meta» y no se devuelve", async () => {
    for (const cuerpo of [{ id: "../me" }, { id: "1234/x" }, { id: 100000000000777 }, {}, []]) {
      graphContesta(cuerpo);
      expect(await agregarNumero(CRED, { cc: "54", numero: "92915550000" }, "Veltra")).toEqual({ ok: false, falla: "meta", codigo: null });
    }
  });

  it("un id de dígitos fuera de lo que guarda la base vuelve igual, para que quien guarda lo descarte con ID_DE_META", async () => {
    graphContesta({ id: "12345" });
    expect(await agregarNumero(CRED, { cc: "54", numero: "92915550000" }, "Veltra")).toEqual({ ok: true, valor: "12345" });
    expect(ID_DE_META.test("12345")).toBe(false);
    expect(ID_DE_META.test("123456")).toBe(true);
    expect(ID_DE_META.test("1".repeat(20))).toBe(true);
    expect(ID_DE_META.test("1".repeat(21))).toBe(false);
    expect(ID_DE_META.test("12345a")).toBe(false);
  });

  it("sin nombre o con una WABA de forma rara no llama a Graph", async () => {
    const fetchFalso = graphContesta({ id: ID });
    const sin = { ok: false, falla: "rechazo", codigo: null };

    expect(await agregarNumero(CRED, { cc: "54", numero: "92915550000" }, "")).toEqual(sin);
    expect(await agregarNumero(CRED, { cc: "54", numero: "92915550000" }, "   ")).toEqual(sin);
    expect(await agregarNumero({ ...CRED, wabaId: "../me" }, { cc: "54", numero: "92915550000" }, "Veltra")).toEqual(sin);
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("pedirCodigoAMeta", () => {
  it("SMS en español y VOICE en inglés, cada uno a request_code del número", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await pedirCodigoAMeta(CRED, ID, "SMS", "es-AR")).toEqual({ ok: true, valor: true });
    expect(await pedirCodigoAMeta(CRED, ID, "VOICE", "en-US")).toEqual({ ok: true, valor: true });

    expect(fetchFalso).toHaveBeenCalledTimes(2);
    const [sms, voz] = fetchFalso.mock.calls as unknown as Array<[string, RequestInit]>;
    for (const [url, init] of [sms, voz]) {
      expect(url).toBe(`${BASE}/${ID}/request_code`);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual(CON_CUERPO);
    }
    expect(JSON.parse(sms[1].body as string)).toEqual({ code_method: "SMS", language: "es" });
    expect(JSON.parse(voz[1].body as string)).toEqual({ code_method: "VOICE", language: "en" });
  });

  it("un 2xx sin success:true es «meta»", async () => {
    for (const cuerpo of [{ success: false }, {}, { success: "true" }]) {
      graphContesta(cuerpo);
      expect(await pedirCodigoAMeta(CRED, ID, "SMS", "es-AR")).toEqual({ ok: false, falla: "meta", codigo: null });
    }
  });
});

describe("verificarCodigoEnMeta", () => {
  it("manda el código a verify_code del número", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await verificarCodigoEnMeta(CRED, ID, "123456")).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}/verify_code`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(CON_CUERPO);
    expect(JSON.parse(init.body as string)).toEqual({ code: "123456" });
  });

  it("lo que no es un código de seis dígitos no sale", async () => {
    const fetchFalso = graphContesta({ success: true });
    for (const raro of ["12345", "1234567", "abcdef", "12 456", "", "123456\n"]) {
      expect(await verificarCodigoEnMeta(CRED, ID, raro)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("un 400 es «rechazo» y trae el code de Graph, no su mensaje", async () => {
    graphContesta({ error: { message: "Código 123456 incorrecto", code: 100 } }, 400);
    expect(await verificarCodigoEnMeta(CRED, ID, "123456")).toEqual({ ok: false, falla: "rechazo", codigo: 100 });
  });
});

describe("codigoYaVerificado", () => {
  it("pregunta por code_verification_status con un GET y sin cuerpo", async () => {
    const fetchFalso = graphContesta({ code_verification_status: "VERIFIED", id: ID });

    expect(await codigoYaVerificado(CRED, ID)).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}?fields=code_verification_status`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(SIN_CUERPO);
    expect(init.body).toBeUndefined();
  });

  it("NOT_VERIFIED y EXPIRED son que no; un estado que no viene es «meta»", async () => {
    for (const estado of ["NOT_VERIFIED", "EXPIRED"]) {
      graphContesta({ code_verification_status: estado });
      expect(await codigoYaVerificado(CRED, ID)).toEqual({ ok: true, valor: false });
    }
    graphContesta({ id: ID });
    expect(await codigoYaVerificado(CRED, ID)).toEqual({ ok: false, falla: "meta", codigo: null });
  });
});

describe("numeroYaRegistrado", () => {
  it("pregunta por status y platform_type con un GET", async () => {
    const fetchFalso = graphContesta({ status: "CONNECTED", platform_type: "CLOUD_API", id: ID });

    expect(await numeroYaRegistrado(CRED, ID)).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}?fields=status,platform_type`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(SIN_CUERPO);
  });

  it("CLOUD_API o CONNECTED alcanzan; un número recién agregado no está registrado", async () => {
    graphContesta({ platform_type: "CLOUD_API" });
    expect(await numeroYaRegistrado(CRED, ID)).toEqual({ ok: true, valor: true });

    graphContesta({ status: "CONNECTED" });
    expect(await numeroYaRegistrado(CRED, ID)).toEqual({ ok: true, valor: true });

    graphContesta({ status: "PENDING", platform_type: "NOT_APPLICABLE" });
    expect(await numeroYaRegistrado(CRED, ID)).toEqual({ ok: true, valor: false });
  });

  it("sin ninguno de los dos campos no se interpreta: «meta»", async () => {
    graphContesta({ id: ID });
    expect(await numeroYaRegistrado(CRED, ID)).toEqual({ ok: false, falla: "meta", codigo: null });
  });
});

describe("registrarNumero", () => {
  it("manda POST a register con un PIN de seis dígitos completado con ceros", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await registrarNumero(CRED, ID)).toEqual({ ok: true, valor: true });

    expect(randomIntFalso).toHaveBeenCalledWith(0, 1_000_000);
    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}/register`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(CON_CUERPO);
    expect(JSON.parse(init.body as string)).toEqual({ messaging_product: "whatsapp", pin: "000042" });
  });

  it("el PIN es siempre de seis dígitos, con el randomInt de verdad", async () => {
    const real = await vi.importActual<typeof import("node:crypto")>("node:crypto");
    randomIntFalso.mockImplementation(() => real.randomInt(0, 1_000_000));
    const fetchFalso = graphContesta({ success: true });

    for (let i = 0; i < 20; i++) await registrarNumero(CRED, ID);

    for (const [, init] of fetchFalso.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(JSON.parse(init.body as string).pin).toMatch(/^\d{6}$/);
    }
  });

  it("un 200 sin success:true es «meta»", async () => {
    graphContesta({ success: false });
    expect(await registrarNumero(CRED, ID)).toEqual({ ok: false, falla: "meta", codigo: null });
  });

  it("con un PIN dado manda ese PIN y no sortea otro", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await registrarNumero(CRED, ID, "012345")).toEqual({ ok: true, valor: true });

    expect(randomIntFalso).not.toHaveBeenCalled();
    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}/register`);
    expect(JSON.parse(init.body as string)).toEqual({ messaging_product: "whatsapp", pin: "012345" });
  });

  it("un PIN que no son seis dígitos no sale, ni se reemplaza por uno al azar", async () => {
    const fetchFalso = graphContesta({ success: true });

    for (const pin of ["", "12345", "1234567", "12345a", "123 45", "000042\n"]) {
      expect(await registrarNumero(CRED, ID, pin)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    }

    expect(fetchFalso).not.toHaveBeenCalled();
    expect(randomIntFalso).not.toHaveBeenCalled();
  });

  it("el PIN dado no llega al log, ni cuando Meta lo rechaza", async () => {
    graphContesta({ error: { message: "pin 654321", code: 133005 } }, 400);

    const r = await registrarNumero(CRED, ID, "654321");

    expect(r).toEqual({ ok: false, falla: "rechazo", codigo: 133005 });
    expect(JSON.stringify([...anotado.map((s) => s.mock.calls), r])).not.toContain("654321");
  });
});

describe("fijarWebhookDelNumero", () => {
  it("manda POST al número con la URL y el token del ambiente en webhook_configuration", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await fijarWebhookDelNumero(CRED, ID, WEBHOOK)).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(CON_CUERPO);
    expect(JSON.parse(init.body as string)).toEqual({
      webhook_configuration: { override_callback_uri: WEBHOOK.url, verify_token: WEBHOOK.verifyToken },
    });
  });

  it("un 2xx sin success:true es «meta», y un 400 es «rechazo» con el code", async () => {
    graphContesta({ success: false });
    expect(await fijarWebhookDelNumero(CRED, ID, WEBHOOK)).toEqual({ ok: false, falla: "meta", codigo: null });

    graphContesta({ error: { code: 100 } }, 400);
    expect(await fijarWebhookDelNumero(CRED, ID, WEBHOOK)).toEqual({ ok: false, falla: "rechazo", codigo: 100 });
  });

  it("un id de forma rara o el de la plataforma no sale", async () => {
    const fetchFalso = graphContesta({ success: true });
    const sin = { ok: false, falla: "rechazo", codigo: null };

    for (const raro of ["../me", "1234/x", "1234", "", PLATAFORMA]) {
      expect(await fijarWebhookDelNumero(CRED, raro, WEBHOOK)).toEqual(sin);
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("webhookPropioEs", () => {
  it("pregunta por webhook_configuration con un GET y sin cuerpo", async () => {
    const fetchFalso = graphContesta({ webhook_configuration: { phone_number: WEBHOOK.url }, id: ID });

    expect(await webhookPropioEs(CRED, ID, WEBHOOK.url)).toEqual({ ok: true, valor: true });

    const { url, init } = unicaLlamada(fetchFalso);
    expect(url).toBe(`${BASE}/${ID}?fields=webhook_configuration`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(SIN_CUERPO);
    expect(init.body).toBeUndefined();
  });

  it("vale el webhook propio del número (phone_number u override_callback_uri), con o sin barra al final", async () => {
    for (const conf of [
      { phone_number: WEBHOOK.url },
      { phone_number: `${WEBHOOK.url}/` },
      { override_callback_uri: WEBHOOK.url },
    ]) {
      graphContesta({ webhook_configuration: conf });
      expect(await webhookPropioEs(CRED, ID, WEBHOOK.url)).toEqual({ ok: true, valor: true });
    }
  });

  it("sin el webhook propio no vale nada: ni el de la app ni el de la WABA, ni otra URL, ni una config que no es objeto", async () => {
    for (const conf of [
      { application: WEBHOOK.url },
      { whatsapp_business_account: WEBHOOK.url },
      { phone_number: "https://dev.example.com/api/webhooks/whatsapp" },
      { phone_number: `${WEBHOOK.url}/otro` },
      { phone_number: 1 },
      {},
      null,
      "x",
      [WEBHOOK.url],
    ]) {
      graphContesta({ webhook_configuration: conf });
      expect(await webhookPropioEs(CRED, ID, WEBHOOK.url)).toEqual({ ok: true, valor: false });
    }
    graphContesta({ id: ID });
    expect(await webhookPropioEs(CRED, ID, WEBHOOK.url)).toEqual({ ok: true, valor: false });
  });

  it("si Graph no contesta bien devuelve la falla, no un «no»", async () => {
    graphContesta({}, 500);
    expect(await webhookPropioEs(CRED, ID, WEBHOOK.url)).toEqual({ ok: false, falla: "meta", codigo: null });

    graphContesta({ error: { code: 100 } }, 400);
    expect(await webhookPropioEs(CRED, ID, WEBHOOK.url)).toEqual({ ok: false, falla: "rechazo", codigo: 100 });

    graphContesta([]);
    expect(await webhookPropioEs(CRED, ID, WEBHOOK.url)).toEqual({ ok: false, falla: "meta", codigo: null });
  });

  it("un id de forma rara o el de la plataforma no sale", async () => {
    const fetchFalso = graphContesta({ webhook_configuration: { phone_number: WEBHOOK.url } });
    const sin = { ok: false, falla: "rechazo", codigo: null };

    for (const raro of ["../me", "1234/x", "", PLATAFORMA]) {
      expect(await webhookPropioEs(CRED, raro, WEBHOOK.url)).toEqual(sin);
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("el token del apretón de manos no se anota, ni cuando Graph falla", async () => {
    for (const [cuerpo, status] of [[{ success: true }, 200], [{}, 500], [{ error: { code: 100 } }, 400]] as const) {
      graphContesta(cuerpo, status);
      await fijarWebhookDelNumero(CRED, ID, WEBHOOK);
      await webhookPropioEs(CRED, ID, WEBHOOK.url);
    }

    expect(JSON.stringify(anotado.map((s) => s.mock.calls))).not.toContain(WEBHOOK.verifyToken);
  });
});

describe("lo que no llega al log ni a quien llama", () => {
  it("de un error de Graph queda el paso, el status y el code, y nada del cuerpo", async () => {
    graphContesta(
      { error: { message: "PIN 000042 distinto, código 123456, número +5491100000000, token fake-access-token", code: 133005 } },
      400
    );

    const r = await registrarNumero(CRED, ID);

    expect(r).toEqual({ ok: false, falla: "rechazo", codigo: 133005 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ paso: "registrar", status: 400, codigo: 133005 }, "whatsapp.alta_numero.graph");

    const todo = JSON.stringify([...anotado.map((s) => s.mock.calls), r]);
    for (const secreto of ["000042", "123456", "5491100000000", "fake-access-token", "distinto"]) {
      expect(todo).not.toContain(secreto);
    }
  });

  it("ni el PIN ni el código se anotan cuando todo sale bien o cuando sale mal", async () => {
    for (const [cuerpo, status] of [[{ success: true }, 200], [{}, 500], [{ error: { code: 4 } }, 400]] as const) {
      graphContesta(cuerpo, status);
      await registrarNumero(CRED, ID);
      await verificarCodigoEnMeta(CRED, ID, "123456");
      await pedirCodigoAMeta(CRED, ID, "SMS", "es-AR");
    }

    const todo = JSON.stringify(anotado.map((s) => s.mock.calls));
    expect(todo).not.toContain("000042");
    expect(todo).not.toContain("123456");
    expect(todo).not.toContain("fake-access-token");
  });
});

describe("clasificar", () => {
  it("429 y los códigos 4, 80007, 130429 y 133016 son «esperar», con el status que traigan", () => {
    expect(clasificar(429, null)).toBe("esperar");
    expect(clasificar(429, 100)).toBe("esperar");
    for (const codigo of [4, 80007, 130429, 133016]) {
      expect(clasificar(400, codigo)).toBe("esperar");
      expect(clasificar(500, codigo)).toBe("esperar");
    }
  });

  it("133008 y 133009 (demasiados intentos de PIN) no cambian el camino de la plataforma: siguen siendo un rechazo", () => {
    // Sólo la WABA propia los trata como espera, en `fallaDeGraph`: acá los comparten los dos caminos.
    for (const codigo of [133008, 133009]) expect(clasificar(400, codigo)).toBe("rechazo");
  });

  it("sin respuesta o con 5xx es «meta»; cualquier otro 4xx es «rechazo»", () => {
    expect(clasificar(null, null)).toBe("meta");
    expect(clasificar(500, null)).toBe("meta");
    expect(clasificar(502, 1)).toBe("meta");
    expect(clasificar(400, null)).toBe("rechazo");
    expect(clasificar(400, 100)).toBe("rechazo");
    expect(clasificar(401, 190)).toBe("rechazo");
    expect(clasificar(404, null)).toBe("rechazo");
  });

  it("un status que no es de error es «meta»: algo salió raro, no un no de Meta", () => {
    expect(clasificar(200, null)).toBe("meta");
    expect(clasificar(302, null)).toBe("meta");
  });

  it("lo mismo sale de las llamadas de verdad, con status, code, red y plazo", async () => {
    const casos: Array<[() => Promise<Response>, string, number | null]> = [
      [async () => respuesta({}, 429), "esperar", null],
      [async () => respuesta({ error: { code: 4 } }, 400), "esperar", 4],
      [async () => respuesta({ error: { code: 80007 } }, 400), "esperar", 80007],
      [async () => respuesta({ error: { code: 130429 } }, 400), "esperar", 130429],
      [async () => respuesta({ error: { code: 133016 } }, 400), "esperar", 133016],
      [async () => respuesta({ error: { code: 100 } }, 400), "rechazo", 100],
      [async () => respuesta({}, 404), "rechazo", null],
      [async () => respuesta({}, 500), "meta", null],
      [async () => respuesta({ error: { code: "raro" } }, 502), "meta", null],
      [async () => ({ ok: false, status: 500, json: async () => { throw new Error("no es JSON"); } }) as unknown as Response, "meta", null],
      [async () => { throw new Error("ECONNRESET"); }, "meta", null],
      [async () => { throw new DOMException("plazo", "TimeoutError"); }, "meta", null],
    ];
    for (const [fetchFalso, falla, codigo] of casos) {
      vi.stubGlobal("fetch", vi.fn(fetchFalso));
      expect(await pedirCodigoAMeta(CRED, ID, "SMS", "es-AR")).toEqual({ ok: false, falla, codigo });
    }
  });
});

describe("ids de forma rara y el número de la plataforma", () => {
  it("lo que no son dígitos no llega a la URL", async () => {
    const fetchFalso = graphContesta({ success: true });

    for (const raro of ["../me", "1234/x", "12345?access_token=x", "1234", "abc12345", ""]) {
      const sin = { ok: false, falla: "rechazo", codigo: null };
      expect(await pedirCodigoAMeta(CRED, raro, "SMS", "es-AR")).toEqual(sin);
      expect(await verificarCodigoEnMeta(CRED, raro, "123456")).toEqual(sin);
      expect(await codigoYaVerificado(CRED, raro)).toEqual(sin);
      expect(await numeroYaRegistrado(CRED, raro)).toEqual(sin);
      expect(await registrarNumero(CRED, raro)).toEqual(sin);
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("el número de la plataforma no se toca: ni pedir código, ni verificar, ni registrar", async () => {
    const fetchFalso = graphContesta({ success: true });
    const sin = { ok: false, falla: "rechazo", codigo: null };

    expect(await pedirCodigoAMeta(CRED, PLATAFORMA, "SMS", "es-AR")).toEqual(sin);
    expect(await verificarCodigoEnMeta(CRED, PLATAFORMA, "123456")).toEqual(sin);
    expect(await codigoYaVerificado(CRED, PLATAFORMA)).toEqual(sin);
    expect(await numeroYaRegistrado(CRED, PLATAFORMA)).toEqual(sin);
    expect(await registrarNumero(CRED, PLATAFORMA)).toEqual(sin);
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("partirNumero", () => {
  it("un móvil argentino queda con el país y el resto, con el 9", () => {
    expect(partirNumero("+5491100000000")).toEqual({ cc: "54", numero: "91100000000" });
    expect(partirNumero("+5491100000001")).toEqual({ cc: "54", numero: "91100000001" });
  });

  it("todo lo demás es null: otros países, fijos, largos raros y sin el +", () => {
    for (const raro of [
      "+12025550000",
      "+34600000000",
      "5491100000000",
      "+541100000000",
      "+54911000000",
      "+549110000000000",
      "+5491100a0000",
      "+54 9 11 0000-0000",
      "",
    ]) {
      expect(partirNumero(raro)).toBeNull();
    }
  });
});

describe("el appsecret_proof de la app propia (R5)", () => {
  const PRUEBA = "b".repeat(64);
  const CON_PRUEBA: CredencialDeAlta = { ...CRED, prueba: PRUEBA };
  const CONSULTA = `appsecret_proof=${PRUEBA}`;

  /** Cada llamada de Graph de este módulo, con su URL sin prueba y lo que contesta Graph. */
  const llamadas: Array<[string, (c: CredencialDeAlta) => Promise<unknown>, string, unknown]> = [
    ["agregarNumero", (c) => agregarNumero(c, { cc: "54", numero: "92915550000" }, "Veltra"), `${WABA}/phone_numbers`, { id: ID }],
    ["pedirCodigoAMeta", (c) => pedirCodigoAMeta(c, ID, "SMS", "es-AR"), `${ID}/request_code`, { success: true }],
    ["verificarCodigoEnMeta", (c) => verificarCodigoEnMeta(c, ID, "123456"), `${ID}/verify_code`, { success: true }],
    ["registrarNumero", (c) => registrarNumero(c, ID), `${ID}/register`, { success: true }],
    ["registrarNumero con PIN", (c) => registrarNumero(c, ID, "654321"), `${ID}/register`, { success: true }],
    ["fijarWebhookDelNumero", (c) => fijarWebhookDelNumero(c, ID, WEBHOOK), ID, { success: true }],
    ["codigoYaVerificado", (c) => codigoYaVerificado(c, ID), `${ID}?fields=code_verification_status`, { code_verification_status: "VERIFIED" }],
    ["numeroYaRegistrado", (c) => numeroYaRegistrado(c, ID), `${ID}?fields=status,platform_type`, { status: "CONNECTED" }],
    ["webhookPropioEs", (c) => webhookPropioEs(c, ID, WEBHOOK.url), `${ID}?fields=webhook_configuration`, { webhook_configuration: {} }],
  ];

  it.each(llamadas)("%s sin prueba pide la URL de siempre", async (_nombre, llamar, ruta, cuerpo) => {
    const fetchFalso = graphContesta(cuerpo);

    await llamar(CRED);

    expect(unicaLlamada(fetchFalso).url).toBe(`${BASE}/${ruta}`);
  });

  it.each(llamadas)("%s con prueba la manda en la consulta si es un GET y en el cuerpo si es un POST (Q24)", async (_nombre, llamar, ruta, cuerpo) => {
    const fetchFalso = graphContesta(cuerpo);

    await llamar(CON_PRUEBA);

    const { url, init } = unicaLlamada(fetchFalso);
    if (init.method === "POST") {
      expect(url).toBe(`${BASE}/${ruta}`);
      expect(JSON.parse(init.body as string).appsecret_proof).toBe(PRUEBA);
    } else {
      expect(url).toBe(`${BASE}/${ruta}${ruta.includes("?") ? "&" : "?"}${CONSULTA}`);
      expect(init.body).toBeUndefined();
    }
    expect(url).not.toContain("fake-access-token");
    expect(JSON.stringify(init.headers)).not.toContain(PRUEBA);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fake-access-token");
  });

  it("el cuerpo de register con prueba es el producto, el PIN y la prueba; sin ella, sólo el producto y el PIN", async () => {
    const fetchFalso = graphContesta({ success: true });

    await registrarNumero(CON_PRUEBA, ID, "654321");
    await registrarNumero(CRED, ID, "654321");

    const [con, sin] = fetchFalso.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(con[1].body as string)).toEqual({ messaging_product: "whatsapp", pin: "654321", appsecret_proof: PRUEBA });
    expect(JSON.parse(sin[1].body as string)).toEqual({ messaging_product: "whatsapp", pin: "654321" });
    expect(con[1].method).toBe("POST");
  });

  it("de un error de Graph con subcódigo, vuelve el subcódigo; sin él, la falla queda como siempre (H11)", async () => {
    graphContesta({ error: { code: 190, error_subcode: 463 } }, 401);
    expect(await registrarNumero(CRED, ID)).toEqual({ ok: false, falla: "rechazo", codigo: 190, subcodigo: 463 });

    graphContesta({ error: { code: 190 } }, 401);
    expect(await registrarNumero(CRED, ID)).toEqual({ ok: false, falla: "rechazo", codigo: 190 });
  });

  it("el PIN y el código no viajan en la URL, tampoco con prueba", async () => {
    const fetchFalso = graphContesta({ success: true });

    await registrarNumero(CON_PRUEBA, ID, "654321");
    await verificarCodigoEnMeta(CON_PRUEBA, ID, "123456");

    for (const [url] of fetchFalso.mock.calls as unknown as Array<[string]>) {
      expect(url).not.toContain("654321");
      expect(url).not.toContain("123456");
    }
  });

  it("un id de forma rara o el de la plataforma no sale aunque haya prueba", async () => {
    const fetchFalso = graphContesta({ success: true });

    expect(await registrarNumero(CON_PRUEBA, "../x")).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(await registrarNumero(CON_PRUEBA, PLATAFORMA)).toEqual({ ok: false, falla: "rechazo", codigo: null });
    expect(await agregarNumero({ ...CON_PRUEBA, wabaId: "../x" }, { cc: "54", numero: "92915550000" }, "Veltra")).toEqual({
      ok: false,
      falla: "rechazo",
      codigo: null,
    });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("de un error de Graph no queda la prueba en el log ni en lo que vuelve", async () => {
    graphContesta({ error: { message: `appsecret_proof ${PRUEBA} inválido`, code: 190 } }, 400);

    const r = await registrarNumero(CON_PRUEBA, ID);

    expect(r).toEqual({ ok: false, falla: "rechazo", codigo: 190 });
    const todo = JSON.stringify([...anotado.map((s) => s.mock.calls), r]);
    expect(todo).not.toContain(PRUEBA);
    expect(todo).not.toContain("fake-access-token");
  });
});
