/**
 * El alta no dice si una dirección ya tiene cuenta.
 *
 * Decía «Ya existe una cuenta con ese correo. Iniciá sesión», y con eso
 * alcanzaba para averiguar quién trabaja en la aseguradora: se prueban
 * direcciones y se lee la respuesta. Es la enumeración de usuarios del manual, y
 * en un producto B2B lo que revela es el padrón de empleados.
 *
 * Ahora TODOS los caminos terminan en el mismo lugar y con el mismo aviso
 * (/login?aviso=revisa_tu_correo): la dirección ya tenía cuenta, se creó, no
 * está en la lista o su dominio exige SSO. El alta ya no deja sesión —manda un
 * enlace para elegir la contraseña—, así que tampoco queda la diferencia de
 * caer en /bandeja que antes delataba una dirección nueva.
 *
 * Y tampoco por el tiempo: la lista, el hash y el mail corren en `after`, con la
 * respuesta ya enviada, así que una dirección habilitada no tarda más que una
 * que no lo está.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSignUpEmail,
  mockRequestPasswordReset,
  mockFindUserById,
  mockWriteAuditLog,
  mockRateLimit,
  mockTopePorIp,
  mockAltaBloqueadaPorSso,
  pendientes,
} = vi.hoisted(
  () => ({
    mockSignUpEmail: vi.fn(),
    mockRequestPasswordReset: vi.fn(),
    mockFindUserById: vi.fn(),
    mockWriteAuditLog: vi.fn(),
    mockRateLimit: vi.fn(),
    mockTopePorIp: vi.fn(),
    mockAltaBloqueadaPorSso: vi.fn(),
    /** Lo que el alta dejó para después de responder (`after`). */
    pendientes: [] as Array<() => unknown>,
  })
);

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "203.0.113.7" })),
}));

/** `redirect` tira, igual que en Next: se atrapa el destino. */
class RedirigioA extends Error {
  constructor(public readonly destino: string) {
    super(`NEXT_REDIRECT:${destino}`);
  }
}

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (tarea: () => unknown) => {
    pendientes.push(tarea);
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new RedirigioA(destino);
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: { signUpEmail: mockSignUpEmail, requestPasswordReset: mockRequestPasswordReset },
    $context: Promise.resolve({ internalAdapter: { findUserById: mockFindUserById } }),
  },
}));

// La consulta a la base de «¿este dominio exige SSO?» es de otra prueba (sso-exigir.test.ts).
vi.mock("@/server/sso/exigir", () => ({ altaBloqueadaPorSso: mockAltaBloqueadaPorSso }));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockWriteAuditLog,
  AuditEvent: { AUTH_SIGN_UP: "auth.sign_up", AUTH_RATE_LIMITED: "auth.rate_limited" },
}));

vi.mock("@/lib/rate-limit/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: mockRateLimit,
  topePorIp: mockTopePorIp,
}));

import { APIError } from "better-auth/api";

/** Corre lo que el alta dejó para después de responder. */
async function correrLoDiferido() {
  await Promise.all(pendientes.splice(0).map((tarea) => tarea()));
}

/**
 * Corre el alta y devuelve adónde redirigió, o el error que devolvió. Con
 * `diferido: false` no corre lo que quedó para después de la respuesta.
 */
async function darDeAlta(diferido = true): Promise<{ destino?: string; error?: string }> {
  const { signUp } = await import("@/app/registro/actions");
  const fd = new FormData();
  fd.set("full_name", "Ana Pérez");
  fd.set("email", "ana@aseguradora.com");

  try {
    const r = (await signUp({}, fd)) as { error?: string };
    return { error: r?.error };
  } catch (e) {
    if (e instanceof RedirigioA) {
      if (diferido) await correrLoDiferido();
      return { destino: e.destino };
    }
    throw e;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  pendientes.length = 0;
  // El alta necesita una aseguradora por omisión para poder provisionar; sin
  // esto corta antes de llegar a lo que se está probando.
  process.env.GOOGLE_DEFAULT_TENANT_ID = "tenant-por-omision-0000-0000-0000";
  /*
   * Y la dirección tiene que estar permitida, por lo mismo: desde que el
   * registro está cerrado, una dirección de afuera de la lista se va al aviso
   * neutro sin llegar nunca al proveedor. Lo que se prueba acá es qué contesta
   * el alta de alguien que SÍ puede registrarse, así que la lista se pone.
   *
   * Que una dirección de afuera termine en ese mismo aviso neutro no es un
   * agujero en esta cobertura: es la propiedad, y la prueba
   * `registro-permitido.test.ts`.
   */
  process.env.SIGNUP_ALLOWED_EMAILS = "@aseguradora.com";
  mockRateLimit.mockResolvedValue({ allowed: true, remaining: 2, resetAt: 0, retryAfterSeconds: 0 });
  mockTopePorIp.mockResolvedValue({ allowed: true, remaining: 29, resetAt: 0, retryAfterSeconds: 0 });
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockAltaBloqueadaPorSso.mockResolvedValue(false);
  mockRequestPasswordReset.mockResolvedValue({ status: true });
  mockFindUserById.mockResolvedValue({ id: "user-nuevo" });
});

const AVISO = "/login?aviso=revisa_tu_correo";

describe("el alta no distingue una dirección que ya existe", () => {
  it("una dirección con cuenta va al login con el aviso neutro", async () => {
    mockSignUpEmail.mockRejectedValue(
      new APIError("UNPROCESSABLE_ENTITY", {
        code: "USER_ALREADY_EXISTS",
        message: "User already exists",
      })
    );

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
    // Y sobre todo: no vuelve un mensaje que lo cuente.
    expect(r.error).toBeUndefined();
  });

  it("un alta que se creó va EXACTAMENTE al mismo lugar", async () => {
    // Es lo que hace que el de arriba no diga nada: si este cayera en otro
    // destino, la diferencia volvería a ser la respuesta.
    mockSignUpEmail.mockResolvedValue({ user: { id: "user-nuevo" }, token: null });

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
  });

  it("la respuesta de mentira de Better Auth para una dirección ya tomada también va al mismo lugar", async () => {
    // Con autoSignIn en false no tira: contesta con un usuario que no existe en la base.
    mockSignUpEmail.mockResolvedValue({ user: { id: "usuario-de-mentira" }, token: null });
    mockFindUserById.mockResolvedValue(null);

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("ningún camino devuelve un mensaje que hable de cuentas existentes", async () => {
    mockSignUpEmail.mockRejectedValue(
      new APIError("UNPROCESSABLE_ENTITY", {
        code: "USER_ALREADY_EXISTS",
        message: "User already exists",
      })
    );

    const r = await darDeAlta();

    expect(JSON.stringify(r)).not.toMatch(/ya existe|already/i);
  });

  it("un fallo del proveedor tampoco se ve: es un error que sólo tendrían las habilitadas", async () => {
    // Si esto devolviera «no se pudo crear la cuenta», una dirección fuera de la
    // lista (que nunca llega al proveedor) y una habilitada contestarían
    // distinto. Queda en los registros del servidor, que es donde se mira.
    mockSignUpEmail.mockRejectedValue(new Error("la base se cayó"));

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
    expect(r.error).toBeUndefined();
  });

  it("responde antes de consultar la lista, de crear la cuenta y de mandar el mail", async () => {
    // Lo que tarda es lo que distinguiría a una dirección habilitada de otra: la
    // lista, el hash de la contraseña y el envío del mail. Nada de eso corre
    // antes de la respuesta, para todas por igual.
    mockSignUpEmail.mockResolvedValue({ user: { id: "user-nuevo" }, token: null });

    const r = await darDeAlta(false);

    expect(r.destino).toBe(AVISO);
    expect(mockAltaBloqueadaPorSso).not.toHaveBeenCalled();
    expect(mockSignUpEmail).not.toHaveBeenCalled();
    expect(mockRequestPasswordReset).not.toHaveBeenCalled();

    await correrLoDiferido();

    expect(mockSignUpEmail).toHaveBeenCalledTimes(1);
    expect(mockRequestPasswordReset).toHaveBeenCalledTimes(1);
  });

  /*
   * La propiedad nueva, desde que el registro esta cerrado.
   *
   * Si una direccion fuera de la lista contestara distinto de una que ya tiene
   * cuenta, alcanzaria con probar direcciones para leer la lista. Y como la
   * lista puede ser de direcciones exactas —lo es cuando el equipo usa
   * casillas de Gmail— eso no revela «que dominios atiende el producto» sino
   * el padron de empleados de la aseguradora.
   *
   * La primera version de este cierre devolvia «no se puede crear una cuenta
   * con esa direccion» y abria exactamente ese agujero.
   */
  it("una dirección fuera de la lista va al MISMO lugar que una ya tomada", async () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "@otra-empresa.com";

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
    expect(r.error).toBeUndefined();
    // Y no se llega a crear nada ni a mandar nada: nadie ocupa una direccion ajena.
    expect(mockSignUpEmail).not.toHaveBeenCalled();
    expect(mockRequestPasswordReset).not.toHaveBeenCalled();
  });

  it("un dominio que exige SSO va al MISMO aviso y no deja una cuenta creada sin sesión posible", async () => {
    // Con «Exigir SSO» el gancho de sesión le negaría la sesión después de crear el
    // usuario: quedaba una cuenta a medias y el reintento contestaba «ya existe».
    // Se corta antes de crear nada, y al mismo lugar que cualquier otro rechazo.
    mockAltaBloqueadaPorSso.mockResolvedValue(true);

    const r = await darDeAlta();

    expect(mockAltaBloqueadaPorSso).toHaveBeenCalledWith("ana@aseguradora.com", "tenant-por-omision-0000-0000-0000");
    expect(r.destino).toBe(AVISO);
    expect(r.error).toBeUndefined();
    expect(mockSignUpEmail).not.toHaveBeenCalled();
    expect(mockRequestPasswordReset).not.toHaveBeenCalled();
  });
});
