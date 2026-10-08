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

import { logger } from "@/lib/observability/logger";
import {
  agregarNumero,
  clasificar,
  codigoYaVerificado,
  ID_GUARDABLE,
  numeroYaRegistrado,
  partirNumero,
  pedirCodigoAMeta,
  registrarNumero,
  verificarCodigoEnMeta,
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

  it("un id de dígitos fuera de lo que guarda la base vuelve igual, para que quien guarda lo descarte con ID_GUARDABLE", async () => {
    graphContesta({ id: "12345" });
    expect(await agregarNumero(CRED, { cc: "54", numero: "92915550000" }, "Veltra")).toEqual({ ok: true, valor: "12345" });
    expect(ID_GUARDABLE.test("12345")).toBe(false);
    expect(ID_GUARDABLE.test("123456")).toBe(true);
    expect(ID_GUARDABLE.test("1".repeat(20))).toBe(true);
    expect(ID_GUARDABLE.test("1".repeat(21))).toBe(false);
    expect(ID_GUARDABLE.test("12345a")).toBe(false);
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
