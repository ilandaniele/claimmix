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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturarLogs, type LogsCapturados } from "../../mocks/capturar-logs";

const { mockSelectDb, mockSelectInquilino } = vi.hoisted(() => ({
  mockSelectDb: vi.fn(),
  mockSelectInquilino: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { select: (...args: unknown[]) => mockSelectDb(...args) } }));
vi.mock("@/data/scope", () => ({
  enTenant: async (_ctx: unknown, fn: (c: unknown) => unknown) =>
    fn({ select: (...args: unknown[]) => mockSelectInquilino(...args) }),
}));
vi.mock("@/lib/security/cifrado", () => ({
  descifrar: (sobre: string) => sobre.replace(/^cifrado:/, ""),
}));

import {
  avisarSinNumero,
  credencialesWhatsApp,
  inquilinoDeLaPlataforma,
  resolverNumeros,
} from "@/server/whatsapp/numeros";

const PLATAFORMA = "10000000-0000-0000-0000-000000000001";
const OTRO = "20000000-0000-0000-0000-000000000002";
const TERCERO = "30000000-0000-0000-0000-000000000003";
const NUMERO_PLATAFORMA = "111111111111111";
const NUMERO_OTRO = "222222222222222";
const NUMERO_TERCERO = "333333333333333";

/** Lo que devuelve una consulta de drizzle: encadenable hasta el final, y se espera. */
function consulta(resultado: unknown[] | Error) {
  const promesa = () => (resultado instanceof Error ? Promise.reject(resultado) : Promise.resolve(resultado));
  const cadena = {
    from: () => cadena,
    innerJoin: () => cadena,
    where: vi.fn(() => cadena),
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => promesa().then(ok, ko),
    catch: (ko: (e: unknown) => unknown) => promesa().catch(ko),
  };
  return cadena;
}

const sinTabla = () => Object.assign(new Error("relation does not exist"), { code: "42P01" });

const ENTORNO = [
  "WHATSAPP_TENANT_ID",
  "GMAIL_TENANT_ID",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
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

describe("resolverNumeros", () => {
  function fila(numero: string, tenantId: string, estado: string, billing = "active") {
    return { phone_number_id: numero, tenant_id: tenantId, estado, billing_status: billing };
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

describe("credencialesWhatsApp", () => {
  const FUTURO = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const PASADO = new Date(Date.now() - 86_400_000).toISOString();

  function viva(extra: Record<string, unknown> = {}) {
    return {
      estado: "conectado",
      phone_number_id: NUMERO_OTRO,
      waba_id: "555555555555555",
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
      wabaId: "555555555555555",
      tenantId: OTRO,
      autoalta: false,
      enPrueba: false,
      vencida: false,
    });
  });

  it("con token propio, lo descifra y no usa el de la plataforma", async () => {
    mockSelectInquilino.mockReturnValue(consulta([viva({ token_cifrado: "cifrado:test-own-token" })]));

    const cred = await credencialesWhatsApp(OTRO);

    expect(cred?.accessToken).toBe("test-own-token");
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

  it("avisarSinNumero anota el inquilino y dónde, sin teléfonos", () => {
    avisarSinNumero(OTRO, "messenger");

    expect(logs.texto()).toContain("whatsapp.sin_numero");
    expect(logs.texto()).toContain(OTRO);
  });
});
