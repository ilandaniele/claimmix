/**
 * Lo que las pantallas saben de la WABA propia (`@/server/alta/waba-publica`): de dónde
 * viene el número, qué camino le toca a cada espacio, qué trae la lectura y qué NO trae
 * (el token y el PIN), y el enlace de ayuda.
 *
 * La base está simulada: acá se prueba lo que se hace con las filas. El SQL real lo
 * ejerce `pnpm tenancy` contra una base de verdad.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enControl: vi.fn(),
  leer: vi.fn(),
  campos: [] as string[][],
  warn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => {
  const cadena: Record<string, unknown> = {};
  for (const paso of ["from", "leftJoin", "where", "limit"]) cadena[paso] = () => cadena;
  cadena.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => h.leer().then(ok, ko);
  const db = {
    select: (campos: Record<string, unknown>) => {
      h.campos.push(Object.keys(campos));
      return cadena;
    },
  };
  return {
    enControl: async (ctx: unknown, armar: (db: unknown) => unknown) => {
      h.enControl(ctx);
      return armar(db);
    },
  };
});
vi.mock("@/lib/observability/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() } }));

import { getT } from "@/lib/i18n";
import { enlaceDeAyuda, leerWabaPublica, metodoDelEspacio, origenDelNumero } from "@/server/alta/waba-publica";

const ESPACIO = "00000000-0000-4000-8000-0000000000a1";
const PLATAFORMA = "100000000000001";
const PROPIA = "200000000000002";
const BANDERAS = [
  "ALTA_NUMERO_AUTOMATICO",
  "ALTA_WABA_PROPIA",
  "META_APP_ID",
  "META_ES_CONFIG_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "ADMIN_EMAILS",
];

const sinEntorno = () => BANDERAS.forEach((nombre) => delete process.env[nombre]);
const conWabaPropia = () => {
  process.env.ALTA_WABA_PROPIA = "1";
  process.env.META_APP_ID = "fake-app-id";
  process.env.META_ES_CONFIG_ID = "fake-config-id";
  process.env.WHATSAPP_APP_SECRET = "fake-app-secret";
};

beforeEach(() => {
  vi.clearAllMocks();
  h.campos.length = 0;
  sinEntorno();
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = PLATAFORMA;
});

afterEach(sinEntorno);

describe("origenDelNumero: de dónde viene el número", () => {
  it.each([
    ["sin número ni WABA", null, null, false, { conWaba: false, idEnLaPlataforma: false }],
    ["número en la WABA de la plataforma", "111111111111111", PLATAFORMA, false, { conWaba: false, idEnLaPlataforma: true }],
    ["número en una WABA propia, con su token", "111111111111111", PROPIA, true, { conWaba: true, idEnLaPlataforma: false }],
    ["número sin WABA anotada (pedido a medias)", "111111111111111", null, false, { conWaba: false, idEnLaPlataforma: true }],
    ["WABA propia sin número todavía", null, PROPIA, true, { conWaba: true, idEnLaPlataforma: false }],
    ["WABA de la plataforma sin número", null, PLATAFORMA, false, { conWaba: false, idEnLaPlataforma: false }],
    ["número de la plataforma que quedó en otra WABA (sin token propio)", "111111111111111", PROPIA, false, { conWaba: false, idEnLaPlataforma: true }],
  ])("%s", (_caso, phoneNumberId, wabaId, conToken, esperado) => {
    expect(origenDelNumero({ phoneNumberId, wabaId, conToken })).toEqual(esperado);
  });

  it("sin WHATSAPP_BUSINESS_ACCOUNT_ID cualquier WABA con token propio es propia", () => {
    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

    expect(origenDelNumero({ phoneNumberId: "111111111111111", wabaId: PLATAFORMA, conToken: true })).toEqual({
      conWaba: true,
      idEnLaPlataforma: false,
    });
  });
});

describe("metodoDelEspacio: qué camino le toca a cada espacio", () => {
  const admin = { esAdmin: true, autoalta: true, yaConectado: false };
  const nuevo = { conWaba: false, idEnLaPlataforma: false };

  it("con la bandera apagada y sin WABA no hay camino", () => {
    expect(metodoDelEspacio({ ...nuevo, ...admin })).toBeNull();
  });

  it("con la bandera apagada pero con WABA propia sigue viendo su estado", () => {
    expect(metodoDelEspacio({ ...nuevo, conWaba: true, ...admin })).toBe("propia");
  });

  it("con la bandera apagada y el código prendido, el código", () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";

    expect(metodoDelEspacio({ ...nuevo, ...admin })).toBe("codigo");
  });

  describe("con la WABA propia prendida", () => {
    beforeEach(conWabaPropia);

    it("un espacio nuevo va por la WABA propia", () => {
      expect(metodoDelEspacio({ ...nuevo, ...admin })).toBe("propia");
    });

    it("quien no es admin no tiene camino", () => {
      expect(metodoDelEspacio({ ...nuevo, ...admin, esAdmin: false })).toBeNull();
    });

    it("un espacio que no vino por el alta no tiene camino", () => {
      expect(metodoDelEspacio({ ...nuevo, ...admin, autoalta: false })).toBeNull();
    });

    it("el número a medias en la plataforma sigue por el código si está prendido", () => {
      process.env.ALTA_NUMERO_AUTOMATICO = "1";

      expect(metodoDelEspacio({ conWaba: false, idEnLaPlataforma: true, ...admin })).toBe("codigo");
    });

    it("el número a medias en la plataforma, con el código apagado, termina por la WABA propia", () => {
      expect(metodoDelEspacio({ conWaba: false, idEnLaPlataforma: true, ...admin })).toBe("propia");
    });

    it("quien ya anda por la WABA de la plataforma no ve el enlace nuevo (Q7)", () => {
      expect(metodoDelEspacio({ conWaba: false, idEnLaPlataforma: true, ...admin, yaConectado: true })).toBeNull();
    });

    it("quien ya conectó su WABA propia la sigue viendo", () => {
      expect(metodoDelEspacio({ conWaba: true, idEnLaPlataforma: false, ...admin, yaConectado: true })).toBe("propia");
    });

    it("quien está conectado por el código sigue por el código si está prendido", () => {
      process.env.ALTA_NUMERO_AUTOMATICO = "1";

      expect(metodoDelEspacio({ conWaba: false, idEnLaPlataforma: true, ...admin, yaConectado: true })).toBe("codigo");
    });

    it("falta una credencial de Meta: es como estar apagada", () => {
      delete process.env.META_APP_ID;

      expect(metodoDelEspacio({ ...nuevo, ...admin })).toBeNull();
    });
  });
});

describe("leerWabaPublica", () => {
  const fila = (extra: Record<string, unknown> = {}) => ({
    nombre: "Aseguradora Sur",
    estado: null,
    origenDeWaba: null,
    falla: null,
    paso: null,
    wabaId: null,
    numeroMeta: null,
    numeroAceptado: null,
    nombreEstado: null,
    plantilla: null,
    numero: null,
    phoneNumberId: null,
    numeroTipeado: "+5491100000000",
    wabaDelNumero: null,
    conToken: false,
    ...extra,
  });

  it.each([
    ["app_propia", "armando", "app_propia"],
    ["app_propia", "conectada", "app_propia"],
    ["embedded_signup", "armando", "embedded_signup"],
    // Una fila de la que el espacio ya salió no decide nada: manda la bandera de la acción.
    ["app_propia", "cancelada", null],
    ["app_propia", "revocada", null],
    ["embedded_signup", "cancelada", null],
    // Sin fila de WABA no hay origen, y una fila vieja sin la columna es la del popup.
    [null, null, null],
    [null, "armando", "embedded_signup"],
  ])("el origen %s con la fila en %s se publica como %s", async (origenDeWaba, estado, esperado) => {
    h.leer.mockResolvedValue([fila({ origenDeWaba, estado })]);

    expect((await leerWabaPublica(ESPACIO))?.origen).toBe(esperado);
  });

  it("una sola consulta, en control, para el espacio", async () => {
    h.leer.mockResolvedValue([fila()]);

    await leerWabaPublica(ESPACIO);

    expect(h.enControl).toHaveBeenCalledOnce();
    expect(h.enControl).toHaveBeenCalledWith({ tenantId: ESPACIO });
    expect(h.campos).toHaveLength(1);
  });

  it("no pide el token ni el PIN: de la fila del número sólo pregunta si hay token", async () => {
    h.leer.mockResolvedValue([fila()]);

    await leerWabaPublica(ESPACIO);

    const pedidos = h.campos[0];
    expect(pedidos).toContain("conToken");
    expect(pedidos.filter((c) => /token|pin|secret|clave/i.test(c))).toEqual(["conToken"]);
  });

  it("un espacio sin WABA ni número: la lista de antes de empezar", async () => {
    h.leer.mockResolvedValue([fila()]);

    expect(await leerWabaPublica(ESPACIO)).toEqual({
      conWaba: false,
      origen: null,
      idEnLaPlataforma: false,
      nombre: "Aseguradora Sur",
      estado: null,
      falla: null,
      paso: null,
      wabaId: null,
      numeroMeta: null,
      numeroTipeado: "+5491100000000",
      numeroDistinto: false,
      nombreEstado: null,
      plantilla: false,
      conToken: false,
      numero: null,
    });
  });

  it("nunca devuelve el texto del token: el resultado no tiene esa clave", async () => {
    h.leer.mockResolvedValue([fila({ estado: "falta_pin", wabaId: PROPIA, wabaDelNumero: PROPIA, conToken: true, token_cifrado: "v1.fake-secreto" })]);

    const w = await leerWabaPublica(ESPACIO);

    expect(JSON.stringify(w)).not.toContain("fake-secreto");
    expect(Object.keys(w ?? {}).filter((c) => /token|pin|secret/i.test(c))).toEqual(["conToken"]);
  });

  it("una fila de WABA propia cuenta aunque el número todavía no exista", async () => {
    h.leer.mockResolvedValue([fila({ estado: "cancelada", paso: "phone_number_setup", wabaId: PROPIA })]);

    const w = await leerWabaPublica(ESPACIO);

    expect(w).toMatchObject({ conWaba: true, idEnLaPlataforma: false, estado: "cancelada", paso: "phone_number_setup" });
  });

  it("un número en la WABA de la plataforma, sin fila de WABA propia, es del camino del código", async () => {
    h.leer.mockResolvedValue([fila({ numero: "pedido", phoneNumberId: "111111111111111", wabaDelNumero: PLATAFORMA })]);

    expect(await leerWabaPublica(ESPACIO)).toMatchObject({ conWaba: false, idEnLaPlataforma: true, numero: "pedido" });
  });

  it("un número de la plataforma que quedó en otra WABA, sin token propio ni fila de WABA propia, no es de esta ruta", async () => {
    h.leer.mockResolvedValue([fila({ numero: "conectado", phoneNumberId: "111111111111111", wabaDelNumero: PROPIA, conToken: false })]);

    expect(await leerWabaPublica(ESPACIO)).toMatchObject({ conWaba: false, idEnLaPlataforma: true });
  });

  it("con fila de WABA propia el número de la plataforma ya no cuenta como del código", async () => {
    h.leer.mockResolvedValue([fila({ estado: "vinculada", wabaId: PROPIA, numero: "pedido", phoneNumberId: "111111111111111", wabaDelNumero: PLATAFORMA })]);

    expect(await leerWabaPublica(ESPACIO)).toMatchObject({ conWaba: true, idEnLaPlataforma: false });
  });

  describe("conToken", () => {
    const base = { estado: "falta_codigo", wabaId: PROPIA, phoneNumberId: "111111111111111", numero: "pedido" };

    it("hay token del número en esa misma WABA", async () => {
      h.leer.mockResolvedValue([fila({ ...base, wabaDelNumero: PROPIA, conToken: true })]);

      expect((await leerWabaPublica(ESPACIO))?.conToken).toBe(true);
    });

    it("hay token pero el número quedó en otra WABA: no sirve", async () => {
      h.leer.mockResolvedValue([fila({ ...base, wabaDelNumero: PLATAFORMA, conToken: true })]);

      expect((await leerWabaPublica(ESPACIO))?.conToken).toBe(false);
    });

    it("no hay token", async () => {
      h.leer.mockResolvedValue([fila({ ...base, wabaDelNumero: PROPIA, conToken: false })]);

      expect((await leerWabaPublica(ESPACIO))?.conToken).toBe(false);
    });
  });

  describe("numeroDistinto", () => {
    const base = { estado: "vinculada", wabaId: PROPIA, numeroTipeado: "+54 9 11 0000 0000" };

    it("Meta informó otro número y la persona no lo aceptó", async () => {
      h.leer.mockResolvedValue([fila({ ...base, numeroMeta: "+541100000001", numeroAceptado: null })]);

      expect((await leerWabaPublica(ESPACIO))?.numeroDistinto).toBe(true);
    });

    it("lo aceptó: ya no es distinto", async () => {
      h.leer.mockResolvedValue([fila({ ...base, numeroMeta: "+541100000001", numeroAceptado: true })]);

      expect((await leerWabaPublica(ESPACIO))?.numeroDistinto).toBe(false);
    });

    it("es el mismo número aunque cambie el 9 argentino", async () => {
      h.leer.mockResolvedValue([fila({ ...base, numeroMeta: "+541100000000" })]);

      expect((await leerWabaPublica(ESPACIO))?.numeroDistinto).toBe(false);
    });

    it("Meta todavía no informó número", async () => {
      h.leer.mockResolvedValue([fila({ ...base, numeroMeta: null })]);

      expect((await leerWabaPublica(ESPACIO))?.numeroDistinto).toBe(false);
    });
  });

  it.each(["pedido", "conectado", "suspendido"] as const)("el estado del número %s pasa tal cual", async (numero) => {
    h.leer.mockResolvedValue([fila({ numero })]);

    expect((await leerWabaPublica(ESPACIO))?.numero).toBe(numero);
  });

  it("un estado de número desconocido es null", async () => {
    h.leer.mockResolvedValue([fila({ numero: "raro" })]);

    expect((await leerWabaPublica(ESPACIO))?.numero).toBeNull();
  });

  it("la plantilla enviada se reduce a un sí o no", async () => {
    h.leer.mockResolvedValue([fila({ estado: "conectada", plantilla: new Date("2026-10-09T12:00:00Z") })]);

    expect((await leerWabaPublica(ESPACIO))?.plantilla).toBe(true);
  });

  it("sin fila del espacio vuelve null", async () => {
    h.leer.mockResolvedValue([]);

    expect(await leerWabaPublica(ESPACIO)).toBeNull();
  });

  it("nunca rechaza: sin la 0051 o con la base caída vuelve null y lo cuenta sin datos", async () => {
    h.leer.mockRejectedValue(Object.assign(new Error('relation "whatsapp_wabas" does not exist con datos del cliente'), { code: "42P01" }));

    await expect(leerWabaPublica(ESPACIO)).resolves.toBeNull();
    expect(h.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("datos del cliente");
  });
});

describe("enlaceDeAyuda", () => {
  const t = getT("es-AR");

  it("sin dirección de operador cargada no hay enlace", () => {
    expect(enlaceDeAyuda(t, { tenantId: ESPACIO, wabaId: PROPIA })).toBeNull();
  });

  it("es un mailto a la primera dirección de operador, normalizada", () => {
    process.env.ADMIN_EMAILS = " Operador@Example.com , otro@example.com";

    const enlace = enlaceDeAyuda(t, { tenantId: ESPACIO, wabaId: PROPIA });

    expect(enlace).toMatch(/^mailto:operador@example\.com\?subject=/);
    expect(enlace).not.toContain("otro@example.com");
  });

  it("lleva el espacio y la WABA en el cuerpo, escapados para la URL", () => {
    process.env.ADMIN_EMAILS = "operador@example.com";

    const enlace = enlaceDeAyuda(t, { tenantId: ESPACIO, wabaId: PROPIA }) ?? "";
    const consulta = new URLSearchParams(enlace.split("?")[1]);

    expect(consulta.get("subject")).toBe("Ayuda para conectar mi WhatsApp");
    expect(consulta.get("body")).toContain(`Espacio: ${ESPACIO}`);
    expect(consulta.get("body")).toContain(`WABA: ${PROPIA}`);
    expect(enlace).not.toMatch(/\s/);
  });

  it("sin WABA todavía, un guion", () => {
    process.env.ADMIN_EMAILS = "operador@example.com";

    const consulta = new URLSearchParams((enlaceDeAyuda(t, { tenantId: ESPACIO, wabaId: null }) ?? "").split("?")[1]);

    expect(consulta.get("body")).toContain("WABA: -");
  });

  it("en inglés", () => {
    process.env.ADMIN_EMAILS = "operador@example.com";

    const consulta = new URLSearchParams((enlaceDeAyuda(getT("en-US"), { tenantId: ESPACIO, wabaId: PROPIA }) ?? "").split("?")[1]);

    expect(consulta.get("subject")).toBe("Help connecting my WhatsApp");
  });

  describe("con un asunto propio (la app propia)", () => {
    const ASUNTO = "Ayuda con la app propia de Aseguradora Sur & Cía";

    beforeEach(() => {
      process.env.ADMIN_EMAILS = "operador@example.com";
    });

    it("lleva ese asunto y no el de siempre", () => {
      const enlace = enlaceDeAyuda(t, { tenantId: ESPACIO, wabaId: PROPIA, asunto: ASUNTO }) ?? "";
      const consulta = new URLSearchParams(enlace.split("?")[1]);

      expect(consulta.get("subject")).toBe(ASUNTO);
      expect(consulta.get("subject")).not.toBe("Ayuda para conectar mi WhatsApp");
    });

    it("lo escapa para la URL: el & y los espacios no cortan la consulta", () => {
      const enlace = enlaceDeAyuda(t, { tenantId: ESPACIO, wabaId: PROPIA, asunto: ASUNTO }) ?? "";

      expect(enlace).toContain(`subject=${encodeURIComponent(ASUNTO)}&body=`);
      expect(enlace).not.toMatch(/\s/);
      expect(new URLSearchParams(enlace.split("?")[1]).get("body")).toContain(`WABA: ${PROPIA}`);
    });

    it("el cuerpo y el destinatario son los mismos", () => {
      const sin = enlaceDeAyuda(t, { tenantId: ESPACIO, wabaId: PROPIA }) ?? "";
      const con = enlaceDeAyuda(t, { tenantId: ESPACIO, wabaId: PROPIA, asunto: ASUNTO }) ?? "";

      expect(con.split("?")[0]).toBe(sin.split("?")[0]);
      expect(new URLSearchParams(con.split("?")[1]).get("body")).toBe(new URLSearchParams(sin.split("?")[1]).get("body"));
    });

    it("un asunto vacío no es «sin asunto»: se respeta", () => {
      const consulta = new URLSearchParams((enlaceDeAyuda(t, { tenantId: ESPACIO, wabaId: PROPIA, asunto: "" }) ?? "").split("?")[1]);

      expect(consulta.get("subject")).toBe("");
    });

    it("sin dirección de operador sigue sin haber enlace", () => {
      delete process.env.ADMIN_EMAILS;

      expect(enlaceDeAyuda(t, { tenantId: ESPACIO, wabaId: PROPIA, asunto: ASUNTO })).toBeNull();
    });
  });
});
