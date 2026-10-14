/**
 * Qué número de WhatsApp es de quién (`@/server/whatsapp/numeros`).
 *
 * Dos mitades: `resolverNumeros` (lo que entra: de qué inquilino es el
 * `phone_number_id` con que Meta firmó el evento) y `credencialesWhatsApp` (lo
 * que sale: con qué número y qué token habla un inquilino).
 *
 * La base está simulada: acá se prueba la tabla de decisión, no el SQL. Que la
 * consulta del ruteo vaya por el rol dueño y la de la credencial por el
 * inquilino lo vigilan `pnpm arquitectura` y `pnpm tenancy`.
 */

import { createHmac } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturarLogs, type LogsCapturados } from "../../mocks/capturar-logs";

const { mockSelectDb, mockSelectInquilino, mockDescifrar } = vi.hoisted(() => ({
  mockSelectDb: vi.fn(),
  mockSelectInquilino: vi.fn(),
  mockDescifrar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { select: (...args: unknown[]) => mockSelectDb(...args) } }));
vi.mock("@/data/scope", () => ({
  enControl: async (_ctx: unknown, fn: (c: unknown) => unknown) =>
    fn({ select: (...args: unknown[]) => mockSelectInquilino(...args) }),
}));
vi.mock("@/lib/security/cifrado", () => ({
  // Un sobre «malo:…» no abre, como uno cifrado con otra clave o con otro AAD.
  descifrar: (sobre: string, mensaje: string, aad?: string) => {
    mockDescifrar(sobre, mensaje, aad);
    if (sobre.startsWith("malo:")) throw new Error("Invalid encrypted payload");
    return sobre.replace(/^cifrado:/, "");
  },
}));

import {
  appDeLaRuta,
  avisarSinNumero,
  credencialDelEntorno,
  credencialesWhatsApp,
  datosLegalesDelSlug,
  inquilinoDeLaPlataforma,
  resolverNumeros,
  wabaDeLaPlataforma,
  webhookDelEntorno,
} from "@/server/whatsapp/numeros";

const PLATAFORMA = "10000000-0000-0000-0000-000000000001";
const OTRO = "20000000-0000-0000-0000-000000000002";
const TERCERO = "30000000-0000-0000-0000-000000000003";
const NUMERO_PLATAFORMA = "111111111111111";
const NUMERO_OTRO = "222222222222222";
const NUMERO_TERCERO = "333333333333333";
const WABA_PLATAFORMA = "444444444444444";
const WABA_PROPIA = "555555555555555";

/** Lo que devuelve una consulta de drizzle: encadenable hasta el final, y se espera. */
function consulta(resultado: unknown[] | Error) {
  const promesa = () => (resultado instanceof Error ? Promise.reject(resultado) : Promise.resolve(resultado));
  const uniones: unknown[][] = [];
  const cadena = {
    uniones,
    from: () => cadena,
    innerJoin: () => cadena,
    leftJoin: (...args: unknown[]) => {
      uniones.push(args);
      return cadena;
    },
    where: vi.fn(() => cadena),
    limit: () => cadena,
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => promesa().then(ok, ko),
    catch: (ko: (e: unknown) => unknown) => promesa().catch(ko),
  };
  return cadena;
}

const sinTabla = () => Object.assign(new Error("relation does not exist"), { code: "42P01" });

/**
 * La condición del `leftJoin` a `whatsapp_wabas`, ya como SQL. La base está simulada y no corre
 * el filtro: lo que se puede vigilar es que la unión sólo traiga la app propia viva de la misma
 * WABA del número (una cancelada o desconectada conserva `origen` pero ya no manda).
 */
function unionConWabas(c: ReturnType<typeof consulta>) {
  const [, condicion] = c.uniones[0] as [unknown, SQL];
  const { sql, params } = new PgDialect().sqlToQuery(condicion);
  return { sql, params };
}

function esperarUnionSoloConLaWabaViva(c: ReturnType<typeof consulta>) {
  const { sql, params } = unionConWabas(c);
  expect(sql).toContain('"whatsapp_wabas"."tenant_id" = "whatsapp_numeros"."tenant_id"');
  expect(sql).toContain('"whatsapp_wabas"."waba_id" = "whatsapp_numeros"."waba_id"');
  expect(sql).toMatch(/"whatsapp_wabas"\."estado" not in/);
  expect(params).toEqual(["cancelada", "revocada"]);
}

const ENTORNO = [
  "WHATSAPP_TENANT_ID",
  "GMAIL_TENANT_ID",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "NEXT_PUBLIC_SITE_URL",
] as const;
const guardado: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENTORNO) {
    guardado[k] = process.env[k];
    delete process.env[k];
  }
  process.env.WHATSAPP_TENANT_ID = PLATAFORMA;
  process.env.WHATSAPP_PHONE_NUMBER_ID = NUMERO_PLATAFORMA;
  process.env.WHATSAPP_ACCESS_TOKEN = "test-platform-token";
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "444444444444444";
});

afterEach(() => {
  for (const k of ENTORNO) {
    if (guardado[k] === undefined) delete process.env[k];
    else process.env[k] = guardado[k];
  }
});

describe("inquilinoDeLaPlataforma", () => {
  it("es WHATSAPP_TENANT_ID", () => {
    expect(inquilinoDeLaPlataforma()).toBe(PLATAFORMA);
  });

  it("sin él, cae en GMAIL_TENANT_ID", () => {
    delete process.env.WHATSAPP_TENANT_ID;
    process.env.GMAIL_TENANT_ID = ` ${OTRO} `;
    expect(inquilinoDeLaPlataforma()).toBe(OTRO);
  });

  it("sin ninguno de los dos, es null y no un inquilino por omisión", () => {
    delete process.env.WHATSAPP_TENANT_ID;
    expect(inquilinoDeLaPlataforma()).toBeNull();
  });
});

describe("wabaDeLaPlataforma", () => {
  it("es WHATSAPP_BUSINESS_ACCOUNT_ID, sin blancos", () => {
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = " 444444444444444 ";
    expect(wabaDeLaPlataforma()).toBe("444444444444444");
  });

  it.each([["sin la variable", undefined], ["vacía", ""], ["sólo blancos", "   "]])("%s: null", (_cual, valor) => {
    if (valor === undefined) delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    else process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = valor;
    expect(wabaDeLaPlataforma()).toBeNull();
  });

  it("la credencial del entorno usa la misma WABA", () => {
    expect(credencialDelEntorno()).toEqual({
      accessToken: "test-platform-token",
      phoneNumberId: NUMERO_PLATAFORMA,
      wabaId: wabaDeLaPlataforma(),
    });
    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    expect(credencialDelEntorno()?.wabaId).toBeNull();
  });
});

describe("webhookDelEntorno", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.example.com";
    process.env.WHATSAPP_VERIFY_TOKEN = "fake-verify-token";
  });

  it("es la ruta del webhook de este sitio, con el token del apretón de manos", () => {
    expect(webhookDelEntorno()).toEqual({
      url: "https://claimmix.example.com/api/webhooks/whatsapp",
      verifyToken: "fake-verify-token",
    });
  });

  it("sin blancos ni barras al final del sitio", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "  https://claimmix.example.com//  ";
    expect(webhookDelEntorno()?.url).toBe("https://claimmix.example.com/api/webhooks/whatsapp");
  });

  it.each([
    ["sin sitio", () => delete process.env.NEXT_PUBLIC_SITE_URL],
    ["sin token", () => delete process.env.WHATSAPP_VERIFY_TOKEN],
    ["con el token vacío", () => (process.env.WHATSAPP_VERIFY_TOKEN = "")],
    ["con un sitio http", () => (process.env.NEXT_PUBLIC_SITE_URL = "http://claimmix.example.com")],
    ["con un sitio que no es una URL", () => (process.env.NEXT_PUBLIC_SITE_URL = "https://")],
    ["con un sitio con blancos adentro", () => (process.env.NEXT_PUBLIC_SITE_URL = "https://claim mix.example.com")],
  ])("%s: null, Meta no se llama", (_cual, preparar) => {
    preparar();
    expect(webhookDelEntorno()).toBeNull();
  });
});

describe("resolverNumeros", () => {
  function fila(numero: string, tenantId: string, estado: string, billing = "active", wabaId: string | null = null) {
    return { phone_number_id: numero, tenant_id: tenantId, estado, billing_status: billing, waba_id: wabaId };
  }

  it("sin ids no consulta nada", async () => {
    const ruta = await resolverNumeros([]);

    expect(ruta.size).toBe(0);
    expect(mockSelectDb).not.toHaveBeenCalled();
  });

  it("una fila conectada manda el número a su inquilino", async () => {
    mockSelectDb.mockReturnValue(consulta([fila(NUMERO_OTRO, OTRO, "conectado")]));

    const ruta = await resolverNumeros([NUMERO_OTRO]);

    expect(ruta.get(NUMERO_OTRO)).toBe(OTRO);
  });

  describe("la WABA que firma el evento", () => {
    let logs: LogsCapturados;
    beforeEach(() => {
      logs = capturarLogs();
    });
    afterEach(() => logs.restaurar());

    it("si no es la de la fila se anota `whatsapp.waba_no_coincide`, y el evento sigue a su inquilino", async () => {
      mockSelectDb.mockReturnValue(consulta([fila(NUMERO_OTRO, OTRO, "conectado", "active", WABA_PROPIA)]));

      const ruta = await resolverNumeros([NUMERO_OTRO], new Map([[NUMERO_OTRO, "999999999999999"]]));

      expect(ruta.get(NUMERO_OTRO)).toBe(OTRO);
      const linea = logs.lineas().find((l) => l.msg === "whatsapp.waba_no_coincide");
      expect(linea).toMatchObject({ tenantId: OTRO, wabaFirmada: "999999999999999", wabaDeLaFila: WABA_PROPIA });
    });

    it("si coincide no se anota nada", async () => {
      mockSelectDb.mockReturnValue(consulta([fila(NUMERO_OTRO, OTRO, "conectado", "active", WABA_PROPIA)]));

      await resolverNumeros([NUMERO_OTRO], new Map([[NUMERO_OTRO, WABA_PROPIA]]));

      expect(logs.texto()).not.toContain("waba_no_coincide");
    });

    it("una fila sin WABA anotada o un evento sin WABA no se comparan", async () => {
      mockSelectDb.mockReturnValue(
        consulta([fila(NUMERO_OTRO, OTRO, "conectado", "active", null), fila(NUMERO_TERCERO, TERCERO, "conectado", "active", WABA_PROPIA)])
      );

      await resolverNumeros([NUMERO_OTRO, NUMERO_TERCERO], new Map([[NUMERO_OTRO, "999999999999999"]]));

      expect(logs.texto()).not.toContain("waba_no_coincide");
    });

    it("sin el mapa de WABAs no se compara nada (los llamadores que no lo tienen siguen igual)", async () => {
      mockSelectDb.mockReturnValue(consulta([fila(NUMERO_OTRO, OTRO, "conectado", "active", WABA_PROPIA)]));

      const ruta = await resolverNumeros([NUMERO_OTRO]);

      expect(ruta.get(NUMERO_OTRO)).toBe(OTRO);
      expect(logs.texto()).not.toContain("waba_no_coincide");
    });
  });

  describe("una app propia del cliente", () => {
    let logs: LogsCapturados;
    beforeEach(() => {
      logs = capturarLogs();
    });
    afterEach(() => logs.restaurar());

    it("su número no se resuelve por el webhook de la plataforma: firma con otro secreto", async () => {
      mockSelectDb.mockReturnValue(consulta([{ ...fila(NUMERO_OTRO, OTRO, "conectado"), origen: "app_propia" }]));

      const ruta = await resolverNumeros([NUMERO_OTRO]);

      expect(ruta.has(NUMERO_OTRO)).toBe(false);
      expect(logs.lineas().find((l) => l.msg === "whatsapp.webhook.app_por_plataforma")).toMatchObject({ tenantId: OTRO });
    });

    it("sólo cuenta la app propia viva de la misma WABA: cancelada o revocada ya no manda sobre el número", async () => {
      const consultaDelRuteo = consulta([fila(NUMERO_OTRO, OTRO, "conectado")]);
      mockSelectDb.mockReturnValue(consultaDelRuteo);

      await resolverNumeros([NUMERO_OTRO]);

      esperarUnionSoloConLaWabaViva(consultaDelRuteo);
    });

    it("una app propia cancelada o desconectada (la unión no la trae: origen null) deja el número entrar por la plataforma", async () => {
      mockSelectDb.mockReturnValue(consulta([{ ...fila(NUMERO_OTRO, OTRO, "conectado"), origen: null }]));

      const ruta = await resolverNumeros([NUMERO_OTRO]);

      expect(ruta.get(NUMERO_OTRO)).toBe(OTRO);
      expect(logs.texto()).not.toContain("app_por_plataforma");
    });

    it.each([["Embedded Signup", "embedded_signup"], ["sin fila de WABA (null)", null]])(
      "%s sigue entrando por la plataforma",
      async (_cual, origen) => {
        mockSelectDb.mockReturnValue(consulta([{ ...fila(NUMERO_OTRO, OTRO, "conectado"), origen }]));

        const ruta = await resolverNumeros([NUMERO_OTRO]);

        expect(ruta.get(NUMERO_OTRO)).toBe(OTRO);
        expect(logs.texto()).not.toContain("app_por_plataforma");
      }
    );

    it("en un lote mixto sólo se descarta la fila de la app propia", async () => {
      mockSelectDb.mockReturnValue(
        consulta([
          { ...fila(NUMERO_OTRO, OTRO, "conectado"), origen: "app_propia" },
          { ...fila(NUMERO_TERCERO, TERCERO, "conectado"), origen: "embedded_signup" },
        ])
      );

      const ruta = await resolverNumeros([NUMERO_OTRO, NUMERO_TERCERO]);

      expect(Object.fromEntries(ruta)).toEqual({ [NUMERO_TERCERO]: TERCERO });
    });
  });

  it("un lote con dos inquilinos: una sola consulta, cada número al suyo", async () => {
    mockSelectDb.mockReturnValue(
      consulta([fila(NUMERO_OTRO, OTRO, "conectado"), fila(NUMERO_TERCERO, TERCERO, "conectado", "trial")])
    );

    const ruta = await resolverNumeros([NUMERO_OTRO, NUMERO_TERCERO, NUMERO_OTRO]);

    expect(mockSelectDb).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(ruta)).toEqual({ [NUMERO_OTRO]: OTRO, [NUMERO_TERCERO]: TERCERO });
  });

  it.each(["pedido", "suspendido", "baja"])("una fila «%s» se descarta", async (estado) => {
    mockSelectDb.mockReturnValue(consulta([fila(NUMERO_OTRO, OTRO, estado)]));

    const ruta = await resolverNumeros([NUMERO_OTRO]);

    expect(ruta.has(NUMERO_OTRO)).toBe(false);
  });

  it.each(["suspended", "churned"])("un inquilino «%s» no recibe nada, aunque el número esté conectado", async (billing) => {
    mockSelectDb.mockReturnValue(consulta([fila(NUMERO_OTRO, OTRO, "conectado", billing)]));

    const ruta = await resolverNumeros([NUMERO_OTRO]);

    expect(ruta.has(NUMERO_OTRO)).toBe(false);
  });

  it("sin fila, el id del .env va al inquilino de la plataforma", async () => {
    mockSelectDb.mockReturnValue(consulta([]));

    const ruta = await resolverNumeros([NUMERO_PLATAFORMA]);

    expect(ruta.get(NUMERO_PLATAFORMA)).toBe(PLATAFORMA);
  });

  it("sin fila, cualquier otro id se descarta: nada cae en un inquilino por omisión", async () => {
    mockSelectDb.mockReturnValue(consulta([]));

    const ruta = await resolverNumeros(["999999999999999"]);

    expect(ruta.size).toBe(0);
  });

  it("una fila suspendida del número de la plataforma gana sobre el .env", async () => {
    mockSelectDb.mockReturnValue(consulta([fila(NUMERO_PLATAFORMA, PLATAFORMA, "suspendido")]));

    const ruta = await resolverNumeros([NUMERO_PLATAFORMA]);

    expect(ruta.has(NUMERO_PLATAFORMA)).toBe(false);
  });

  it("si el número de la plataforma está conectado a otro inquilino, va a ese", async () => {
    mockSelectDb.mockReturnValue(consulta([fila(NUMERO_PLATAFORMA, OTRO, "conectado")]));

    const ruta = await resolverNumeros([NUMERO_PLATAFORMA]);

    expect(ruta.get(NUMERO_PLATAFORMA)).toBe(OTRO);
  });

  it("sin inquilino de la plataforma configurado, su número no entra a ninguno", async () => {
    delete process.env.WHATSAPP_TENANT_ID;
    mockSelectDb.mockReturnValue(consulta([]));

    const ruta = await resolverNumeros([NUMERO_PLATAFORMA]);

    expect(ruta.size).toBe(0);
  });

  it("sin la 0048 (42P01) queda sólo la regla de la plataforma", async () => {
    mockSelectDb.mockReturnValue(consulta(sinTabla()));

    const ruta = await resolverNumeros([NUMERO_PLATAFORMA, NUMERO_OTRO]);

    expect(Object.fromEntries(ruta)).toEqual({ [NUMERO_PLATAFORMA]: PLATAFORMA });
  });

  it("con la 0048 y sin la 0051 (falta whatsapp_wabas) sigue ruteando por la fila del número", async () => {
    mockSelectDb
      .mockReturnValueOnce(consulta(sinTabla()))
      .mockReturnValueOnce(consulta([fila(NUMERO_OTRO, OTRO, "conectado"), fila(NUMERO_PLATAFORMA, PLATAFORMA, "suspendido")]));

    const ruta = await resolverNumeros([NUMERO_OTRO, NUMERO_PLATAFORMA]);

    expect(mockSelectDb).toHaveBeenCalledTimes(2);
    expect(Object.fromEntries(ruta)).toEqual({ [NUMERO_OTRO]: OTRO });
  });

  it("el 42P01 que Drizzle mete en `cause` también cuenta", async () => {
    mockSelectDb.mockReturnValue(consulta(Object.assign(new Error("Failed query"), { cause: { code: "42P01" } })));

    const ruta = await resolverNumeros([NUMERO_PLATAFORMA]);

    expect(ruta.get(NUMERO_PLATAFORMA)).toBe(PLATAFORMA);
  });

  it("cualquier otro error de la base se tira: no se resuelve «por las dudas»", async () => {
    mockSelectDb.mockReturnValue(consulta(new Error("fetch failed")));

    await expect(resolverNumeros([NUMERO_PLATAFORMA])).rejects.toThrow("fetch failed");
  });
});

describe("appDeLaRuta", () => {
  let logs: LogsCapturados;
  let n = 0;
  /** El caché es del módulo: cada test usa una ruta que nadie usó. */
  const rutaNueva = () => `ruta-${++n}-${"x".repeat(20)}`;

  function filaApp(extra: Record<string, unknown> = {}) {
    return {
      tenant_id: OTRO,
      app_id: "fake-app-id",
      app_secreto_cifrado: "cifrado:fake-client-app-secret",
      waba_id: WABA_PROPIA,
      estado: "conectada",
      primer_mensaje_en: null,
      actualizado_en: "2026-10-13 12:00:00.123+00",
      phone_number_id: NUMERO_OTRO,
      numero_estado: "conectado",
      billing_status: "active",
      ...extra,
    };
  }

  beforeEach(() => {
    logs = capturarLogs();
  });
  afterEach(() => {
    logs.restaurar();
    vi.useRealTimers();
  });

  it("arma la fila con lo que trae la consulta, sin abrir el secreto", async () => {
    mockSelectDb.mockReturnValue(consulta([filaApp()]));

    const app = await appDeLaRuta(rutaNueva());

    expect(app).toEqual({
      tenantId: OTRO,
      appId: "fake-app-id",
      secretoCifrado: "cifrado:fake-client-app-secret",
      wabaId: WABA_PROPIA,
      phoneNumberId: NUMERO_OTRO,
      estado: "conectada",
      numeroEstado: "conectado",
      primerMensaje: false,
      sinServicio: false,
      actualizadoEn: Date.parse("2026-10-13T12:00:00.123Z"),
    });
    expect(mockDescifrar).not.toHaveBeenCalled();
  });

  it("actualizadoEn es null cuando la base no trae la hora del último cambio", async () => {
    mockSelectDb.mockReturnValue(consulta([filaApp({ actualizado_en: undefined })]));

    expect((await appDeLaRuta(rutaNueva()))?.actualizadoEn).toBeNull();
  });

  it("una sola consulta por ruta", async () => {
    mockSelectDb.mockReturnValue(consulta([filaApp()]));

    await appDeLaRuta(rutaNueva());

    expect(mockSelectDb).toHaveBeenCalledTimes(1);
  });

  it("primerMensaje es true cuando ya hay fecha", async () => {
    mockSelectDb.mockReturnValue(consulta([filaApp({ primer_mensaje_en: new Date() })]));

    expect((await appDeLaRuta(rutaNueva()))?.primerMensaje).toBe(true);
  });

  it.each([
    ["suspended", true],
    ["churned", true],
    ["trial", false],
    ["active", false],
  ])("cobro «%s»: sinServicio %s", async (billing_status, esperado) => {
    mockSelectDb.mockReturnValue(consulta([filaApp({ billing_status })]));

    expect((await appDeLaRuta(rutaNueva()))?.sinServicio).toBe(esperado);
  });

  it("sin número vivo, el número y su estado vienen null (la app puede estar conectada sin número)", async () => {
    mockSelectDb.mockReturnValue(consulta([filaApp({ phone_number_id: null, numero_estado: null, waba_id: null })]));

    expect(await appDeLaRuta(rutaNueva())).toMatchObject({ wabaId: null, phoneNumberId: null, numeroEstado: null });
  });

  it.each([
    ["sin fila", () => []],
    ["sin App ID", () => [filaApp({ app_id: null })]],
    ["sin secreto", () => [filaApp({ app_secreto_cifrado: null })]],
  ])("%s: null", async (_cual, filas) => {
    mockSelectDb.mockReturnValue(consulta(filas()));

    expect(await appDeLaRuta(rutaNueva())).toBeNull();
  });

  it("lo guarda 30 s: la segunda no vuelve a la base", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    mockSelectDb.mockReturnValue(consulta([filaApp()]));
    const ruta = rutaNueva();

    const primera = await appDeLaRuta(ruta);
    vi.advanceTimersByTime(29_000);
    const segunda = await appDeLaRuta(ruta);

    expect(segunda).toBe(primera);
    expect(mockSelectDb).toHaveBeenCalledTimes(1);
  });

  it("pasados los 30 s vuelve a leer y ve el cambio", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const ruta = rutaNueva();
    mockSelectDb.mockReturnValueOnce(consulta([filaApp({ estado: "conectada" })]));
    mockSelectDb.mockReturnValueOnce(consulta([filaApp({ estado: "revocada" })]));

    expect((await appDeLaRuta(ruta))?.estado).toBe("conectada");
    vi.advanceTimersByTime(30_001);
    expect((await appDeLaRuta(ruta))?.estado).toBe("revocada");
    expect(mockSelectDb).toHaveBeenCalledTimes(2);
  });

  it("fresca: se salta el caché y ve el estado de ahora (el número se acaba de conectar)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const ruta = rutaNueva();
    mockSelectDb.mockReturnValueOnce(consulta([filaApp({ estado: "falta_pin", numero_estado: "pedido" })]));
    mockSelectDb.mockReturnValueOnce(consulta([filaApp({ estado: "conectada", numero_estado: "conectado" })]));

    expect((await appDeLaRuta(ruta))?.numeroEstado).toBe("pedido");
    vi.advanceTimersByTime(5_000);
    // Sin `fresca` sigue viendo lo de antes: es el caché de 30 s.
    expect((await appDeLaRuta(ruta))?.numeroEstado).toBe("pedido");
    expect(mockSelectDb).toHaveBeenCalledTimes(1);

    expect((await appDeLaRuta(ruta, { fresca: true }))?.numeroEstado).toBe("conectado");
    expect(mockSelectDb).toHaveBeenCalledTimes(2);
  });

  it("fresca renueva el caché: los pedidos siguientes ya ven lo de ahora sin otra consulta", async () => {
    const ruta = rutaNueva();
    mockSelectDb.mockReturnValueOnce(consulta([filaApp({ numero_estado: "pedido" })]));
    mockSelectDb.mockReturnValueOnce(consulta([filaApp({ numero_estado: "conectado" })]));

    await appDeLaRuta(ruta);
    await appDeLaRuta(ruta, { fresca: true });

    expect((await appDeLaRuta(ruta))?.numeroEstado).toBe("conectado");
    expect(mockSelectDb).toHaveBeenCalledTimes(2);
  });

  it("guarda también el nulo: una ruta inventada pega una vez cada 30 s, no una por pedido", async () => {
    mockSelectDb.mockReturnValue(consulta([]));
    const ruta = rutaNueva();

    expect(await appDeLaRuta(ruta)).toBeNull();
    expect(await appDeLaRuta(ruta)).toBeNull();
    expect(await appDeLaRuta(ruta)).toBeNull();

    expect(mockSelectDb).toHaveBeenCalledTimes(1);
  });

  it("cada ruta tiene su lugar", async () => {
    mockSelectDb.mockReturnValueOnce(consulta([filaApp({ tenant_id: OTRO })]));
    mockSelectDb.mockReturnValueOnce(consulta([filaApp({ tenant_id: TERCERO })]));

    const a = await appDeLaRuta(rutaNueva());
    const b = await appDeLaRuta(rutaNueva());

    expect([a?.tenantId, b?.tenantId]).toEqual([OTRO, TERCERO]);
  });

  it("un error de la base se tira y no se guarda: el pedido siguiente reintenta", async () => {
    const ruta = rutaNueva();
    mockSelectDb.mockReturnValueOnce(consulta(new Error("fetch failed")));
    mockSelectDb.mockReturnValueOnce(consulta([filaApp()]));

    await expect(appDeLaRuta(ruta)).rejects.toThrow("fetch failed");
    expect((await appDeLaRuta(ruta))?.tenantId).toBe(OTRO);
  });

  it("el mapa tiene tope: miles de rutas inventadas no lo agrandan sin límite", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    mockSelectDb.mockImplementation(() => consulta([]));
    const primera = rutaNueva();

    await appDeLaRuta(primera);
    for (let i = 0; i < 1000; i++) await appDeLaRuta(rutaNueva());
    mockSelectDb.mockClear();
    await appDeLaRuta(primera);

    // La más vieja salió para dejar lugar: vuelve a la base.
    expect(mockSelectDb).toHaveBeenCalledTimes(1);
  });
});

describe("datosLegalesDelSlug", () => {
  const completa = { razon_social: "Seguros del Sur SA", cuit: "30-12345678-9", contact_email: "contacto@example.com" };

  it("devuelve razón social, CUIT y mail de contacto", async () => {
    mockSelectDb.mockReturnValue(consulta([completa]));

    expect(await datosLegalesDelSlug("slug-a")).toEqual({
      razonSocial: "Seguros del Sur SA",
      cuit: "30-12345678-9",
      contacto: "contacto@example.com",
    });
    expect(mockSelectDb).toHaveBeenCalledTimes(1);
  });

  it("sin mail de contacto, el contacto es null", async () => {
    mockSelectDb.mockReturnValue(consulta([{ ...completa, contact_email: null }]));

    expect((await datosLegalesDelSlug("slug-a"))?.contacto).toBeNull();
  });

  it.each([
    ["sin fila", []],
    ["sin razón social", [{ ...completa, razon_social: null }]],
    ["con la razón social vacía", [{ ...completa, razon_social: "" }]],
    ["sin CUIT", [{ ...completa, cuit: null }]],
  ])("%s: null, no hay página", async (_cual, filas) => {
    mockSelectDb.mockReturnValue(consulta(filas));

    expect(await datosLegalesDelSlug("slug-a")).toBeNull();
  });

  it("un error de la base se tira: la página no inventa datos", async () => {
    mockSelectDb.mockReturnValue(consulta(new Error("fetch failed")));

    await expect(datosLegalesDelSlug("slug-a")).rejects.toThrow("fetch failed");
  });
});

describe("credencialesWhatsApp", () => {
  const FUTURO = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const PASADO = new Date(Date.now() - 86_400_000).toISOString();

  function viva(extra: Record<string, unknown> = {}) {
    return {
      estado: "conectado",
      phone_number_id: NUMERO_OTRO,
      waba_id: WABA_PLATAFORMA,
      token_cifrado: null,
      billing_status: "active",
      trial_ends_at: null,
      autoalta: false,
      ...extra,
    };
  }

  let logs: LogsCapturados;
  beforeEach(() => {
    logs = capturarLogs();
  });
  afterEach(() => logs.restaurar());

  it("fila conectada con token NULL: su número y el token de la plataforma", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva()]));

    const cred = await credencialesWhatsApp(OTRO);

    expect(cred).toEqual({
      accessToken: "test-platform-token",
      phoneNumberId: NUMERO_OTRO,
      wabaId: WABA_PLATAFORMA,
      tenantId: OTRO,
      autoalta: false,
      enPrueba: false,
      vencida: false,
      propia: false,
    });
  });

  it("con token propio, lo descifra, no usa el de la plataforma y se sabe que la WABA es suya", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ token_cifrado: "cifrado:test-own-token" })]));

    const cred = await credencialesWhatsApp(OTRO);

    expect(cred?.accessToken).toBe("test-own-token");
    expect(cred?.propia).toBe(true);
  });

  it("el sobre se abre con el AAD de su espacio y su WABA", async () => {
    mockSelectInquilino.mockReturnValue(
      consulta([viva({ waba_id: WABA_PROPIA, token_cifrado: "cifrado:test-own-token" })])
    );

    const cred = await credencialesWhatsApp(OTRO);

    expect(cred).toMatchObject({ accessToken: "test-own-token", wabaId: WABA_PROPIA });
    expect(mockDescifrar).toHaveBeenCalledWith("cifrado:test-own-token", expect.any(String), `wa:${OTRO}:${WABA_PROPIA}`);
  });

  it("un sobre que no abre (otra clave u otro espacio): null y no el token de la plataforma", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ waba_id: WABA_PROPIA, token_cifrado: "malo:test-own-token" })]));

    expect(await credencialesWhatsApp(OTRO)).toBeNull();
    expect(logs.texto()).toContain("whatsapp.credenciales_sin_token");
  });

  it("una fila sin token propio sigue con el del .env aunque su WABA no sea la que está cargada (la de prueba)", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ waba_id: WABA_PROPIA, token_cifrado: null })]));

    const cred = await credencialesWhatsApp(OTRO);

    expect(cred).toMatchObject({ accessToken: "test-platform-token", wabaId: WABA_PROPIA, propia: false });
  });

  it("sin WHATSAPP_BUSINESS_ACCOUNT_ID cargada (es opcional), una fila conectada sin token propio sigue mandando", async () => {
    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    mockSelectInquilino.mockReturnValue(consulta([viva()]));

    expect((await credencialesWhatsApp(OTRO))?.accessToken).toBe("test-platform-token");
  });

  it("la WABA de la plataforma sin token propio sigue con el token del .env", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ waba_id: WABA_PLATAFORMA, token_cifrado: null })]));

    expect((await credencialesWhatsApp(OTRO))?.accessToken).toBe("test-platform-token");
  });

  it("una fila sin WABA anotada (anterior a la 0051) cuenta como de la plataforma", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ waba_id: null, token_cifrado: null })]));

    expect((await credencialesWhatsApp(OTRO))?.accessToken).toBe("test-platform-token");
  });

  it("sin WABA anotada no hay con qué abrir un token cifrado: null", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ waba_id: null, token_cifrado: "cifrado:test-own-token" })]));

    expect(await credencialesWhatsApp(OTRO)).toBeNull();
  });

  it("conectada pero sin token de ninguna clase: null", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    mockSelectInquilino.mockReturnValue(consulta([viva()]));

    expect(await credencialesWhatsApp(OTRO)).toBeNull();
  });

  it("conectada pero sin phone_number_id: null", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ phone_number_id: null })]));

    expect(await credencialesWhatsApp(OTRO)).toBeNull();
  });

  it.each(["pedido", "suspendido", "baja"])("fila «%s»: null", async (estado) => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ estado })]));

    expect(await credencialesWhatsApp(OTRO)).toBeNull();
  });

  it("una fila suspendida de la plataforma la corta aunque el .env esté completo", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ estado: "suspendido", phone_number_id: NUMERO_PLATAFORMA })]));

    expect(await credencialesWhatsApp(PLATAFORMA)).toBeNull();
  });

  it.each(["suspended", "churned"])(
    "un inquilino «%s» con el número conectado: null, no se manda nada en su nombre",
    async (billing_status) => {
      mockSelectInquilino.mockReturnValue(consulta([viva({ billing_status })]));

      expect(await credencialesWhatsApp(OTRO)).toBeNull();
    }
  );

  it.each(["trial", "active"])("un inquilino «%s» con el número conectado sigue hablando", async (billing_status) => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ billing_status })]));

    expect((await credencialesWhatsApp(OTRO))?.phoneNumberId).toBe(NUMERO_OTRO);
  });

  it("si hay una conectada entre varias filas, es la que vale", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ estado: "baja" }), viva()]));

    const cred = await credencialesWhatsApp(OTRO);

    expect(cred?.phoneNumberId).toBe(NUMERO_OTRO);
  });

  it("sin fila, la plataforma habla con el .env", async () => {
    mockSelectInquilino.mockReturnValue(consulta([]));

    const cred = await credencialesWhatsApp(PLATAFORMA);

    expect(cred).toEqual({
      accessToken: "test-platform-token",
      phoneNumberId: NUMERO_PLATAFORMA,
      wabaId: "444444444444444",
      tenantId: PLATAFORMA,
      autoalta: false,
      enPrueba: false,
      vencida: false,
      propia: false,
    });
  });

  it("sin fila y con el .env incompleto, la plataforma tampoco tiene con qué mandar", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    mockSelectInquilino.mockReturnValue(consulta([]));

    expect(await credencialesWhatsApp(PLATAFORMA)).toBeNull();
  });

  it("sin fila, cualquier otro inquilino no tiene número", async () => {
    mockSelectInquilino.mockReturnValue(consulta([]));

    expect(await credencialesWhatsApp(OTRO)).toBeNull();
  });

  it("sin la 0048 (42P01), la plataforma sigue con el .env y los demás sin número", async () => {
    mockSelectInquilino.mockReturnValue(consulta(sinTabla()));

    expect((await credencialesWhatsApp(PLATAFORMA))?.phoneNumberId).toBe(NUMERO_PLATAFORMA);
    expect(await credencialesWhatsApp(OTRO)).toBeNull();
  });

  it("con la 0048 y sin la 0051 (falta whatsapp_wabas) el inquilino sigue con su número y la plataforma con su fila suspendida", async () => {
    mockSelectInquilino
      .mockReturnValueOnce(consulta(sinTabla()))
      .mockReturnValueOnce(consulta([viva()]));
    expect((await credencialesWhatsApp(OTRO))?.phoneNumberId).toBe(NUMERO_OTRO);

    mockSelectInquilino
      .mockReturnValueOnce(consulta(sinTabla()))
      .mockReturnValueOnce(consulta([viva({ estado: "suspendido" })]));
    expect(await credencialesWhatsApp(PLATAFORMA)).toBeNull();
  });

  it("un error de la base no tira ni cae al .env: devuelve null y lo anota", async () => {
    mockSelectInquilino.mockReturnValue(consulta(new Error("fetch failed")));

    expect(await credencialesWhatsApp(PLATAFORMA)).toBeNull();
    expect(logs.texto()).toContain("whatsapp.credenciales_error");
  });

  it("un espacio del alta automática con la prueba corrida está vencido", async () => {
    mockSelectInquilino.mockReturnValue(
      consulta([viva({ autoalta: true, billing_status: "trial", trial_ends_at: PASADO })])
    );

    const cred = await credencialesWhatsApp(OTRO);

    expect(cred).toMatchObject({ autoalta: true, enPrueba: true, vencida: true });
  });

  it("con la prueba en curso no está vencido", async () => {
    mockSelectInquilino.mockReturnValue(
      consulta([viva({ autoalta: true, billing_status: "trial", trial_ends_at: FUTURO })])
    );

    const cred = await credencialesWhatsApp(OTRO);

    expect(cred).toMatchObject({ autoalta: true, enPrueba: true, vencida: false });
  });

  it("un alta automática que ya paga sigue siendo autoalta pero deja de estar en prueba", async () => {
    mockSelectInquilino.mockReturnValue(
      consulta([viva({ autoalta: true, billing_status: "active", trial_ends_at: PASADO })])
    );

    const cred = await credencialesWhatsApp(OTRO);

    expect(cred).toMatchObject({ autoalta: true, enPrueba: false, vencida: false });
  });

  it("un inquilino que no vino por el alta automática no vence nunca, aunque la fecha haya pasado", async () => {
    mockSelectInquilino.mockReturnValue(
      consulta([viva({ autoalta: false, billing_status: "trial", trial_ends_at: PASADO })])
    );

    const cred = await credencialesWhatsApp(OTRO);

    expect(cred).toMatchObject({ autoalta: false, enPrueba: false, vencida: false });
  });

  describe("app propia del cliente", () => {
    const APP_ID = "fake-app-id";
    const SECRETO = "fake-client-app-secret";
    const TOKEN = "test-client-system-token-key";

    const delCliente = (extra: Record<string, unknown> = {}) =>
      viva({
        waba_id: WABA_PROPIA,
        token_cifrado: `cifrado:${TOKEN}`,
        origen: "app_propia",
        app_id: APP_ID,
        app_secreto_cifrado: `cifrado:${SECRETO}`,
        primera_respuesta_en: null,
        ...extra,
      });

    it("sólo cuenta la app propia viva de la misma WABA: cancelada o revocada no le quita el envío al cliente", async () => {
      const consultaDeLaCredencial = consulta([delCliente()]);
      mockSelectInquilino.mockReturnValue(consultaDeLaCredencial);

      await credencialesWhatsApp(OTRO);

      esperarUnionSoloConLaWabaViva(consultaDeLaCredencial);
    });

    it("una app propia cancelada o desconectada (la unión no la trae) envía con las credenciales del número, sin pedir secreto", async () => {
      mockSelectInquilino.mockReturnValue(
        consulta([viva({ origen: null, app_id: null, app_secreto_cifrado: null, primera_respuesta_en: null })])
      );

      const cred = await credencialesWhatsApp(OTRO);

      expect(cred).toMatchObject({ accessToken: "test-platform-token", phoneNumberId: NUMERO_OTRO, tenantId: OTRO });
      expect(cred).not.toHaveProperty("prueba");
      expect(logs.texto()).not.toContain("credenciales_sin_secreto");
    });

    it("devuelve la prueba del secreto (HMAC-SHA256 del token) y nunca el secreto", async () => {
      mockSelectInquilino.mockReturnValue(consulta([delCliente()]));

      const cred = await credencialesWhatsApp(OTRO);

      const esperada = createHmac("sha256", SECRETO).update(TOKEN).digest("hex");
      expect(cred).toMatchObject({ accessToken: TOKEN, prueba: esperada, propia: true });
      expect(JSON.stringify(cred)).not.toContain(SECRETO);
    });

    it("abre el secreto con el AAD de su espacio y su App ID", async () => {
      mockSelectInquilino.mockReturnValue(consulta([delCliente()]));

      await credencialesWhatsApp(OTRO);

      expect(mockDescifrar).toHaveBeenCalledWith(`cifrado:${SECRETO}`, expect.any(String), `wa-secreto:${OTRO}:${APP_ID}`);
    });

    it("sin ninguna respuesta todavía: primeraRespuestaPendiente es true", async () => {
      mockSelectInquilino.mockReturnValue(consulta([delCliente({ primera_respuesta_en: null })]));

      expect((await credencialesWhatsApp(OTRO))?.primeraRespuestaPendiente).toBe(true);
    });

    it("con la primera respuesta ya marcada: primeraRespuestaPendiente es false, la prueba sigue", async () => {
      mockSelectInquilino.mockReturnValue(consulta([delCliente({ primera_respuesta_en: new Date() })]));

      const cred = await credencialesWhatsApp(OTRO);

      expect(cred?.primeraRespuestaPendiente).toBe(false);
      expect(cred?.prueba).toEqual(expect.any(String));
    });

    it("un secreto que no abre: null y se anota, sin mandar sin prueba", async () => {
      mockSelectInquilino.mockReturnValue(consulta([delCliente({ app_secreto_cifrado: "malo:fake-client-app-secret" })]));

      expect(await credencialesWhatsApp(OTRO)).toBeNull();
      expect(logs.lineas().find((l) => l.msg === "whatsapp.credenciales_sin_secreto")).toMatchObject({ tenantId: OTRO });
    });

    it.each([
      ["sin secreto guardado", { app_secreto_cifrado: null }],
      ["sin App ID", { app_id: null }],
    ])("%s: null, el AAD no se puede armar", async (_cual, extra) => {
      mockSelectInquilino.mockReturnValue(consulta([delCliente(extra)]));

      expect(await credencialesWhatsApp(OTRO)).toBeNull();
      expect(logs.texto()).toContain("whatsapp.credenciales_sin_secreto");
    });

    it.each([
      ["Embedded Signup", { origen: "embedded_signup" }],
      ["sin fila de WABA", { origen: null, app_id: null, app_secreto_cifrado: null }],
      ["origen ausente (anterior a la 0051)", { origen: undefined }],
    ])("%s: sin prueba ni primera respuesta, como antes", async (_cual, extra) => {
      mockSelectInquilino.mockReturnValue(consulta([delCliente(extra)]));

      const cred = await credencialesWhatsApp(OTRO);

      expect(cred).not.toBeNull();
      expect(cred).not.toHaveProperty("prueba");
      expect(cred).not.toHaveProperty("primeraRespuestaPendiente");
    });

    it("el token de la plataforma tampoco lleva prueba: nunca se firma con un secreto ajeno", async () => {
      mockSelectInquilino.mockReturnValue(consulta([viva()]));

      expect(await credencialesWhatsApp(OTRO)).not.toHaveProperty("prueba");
    });
  });

  it("avisarSinNumero anota el inquilino y dónde, sin teléfonos", () => {
    avisarSinNumero(OTRO, "messenger");

    expect(logs.texto()).toContain("whatsapp.sin_numero");
    expect(logs.texto()).toContain(OTRO);
  });
});
