/**
 * El alta no dice si una dirección ya tiene cuenta.
 *
 * Decía «Ya existe una cuenta con ese correo. Iniciá sesión», y con eso
 * alcanzaba para averiguar quién trabaja en la aseguradora: se prueban
 * direcciones y se lee la respuesta. Es la enumeración de usuarios del manual, y
 * en un producto B2B lo que revela es el padrón de empleados.
 *
 * Ahora los dos caminos terminan en el mismo lugar y con el mismo aviso:
 *
 *   · la dirección ya tenía cuenta        → /login?aviso=usa_tu_cuenta
 *   · se creó pero no quedó sesión        → /login?aviso=usa_tu_cuenta
 *
 * ── Lo que esto NO arregla ──────────────────────────────────────────────────
 *
 * Un alta NUEVA de una dirección permitida sí deja sesión y cae en /bandeja,
 * así que llegar ahí revela que la dirección no existía. La diferencia es que
 * eso ya no es una sonda pasiva —hay que crear la cuenta de verdad, que queda
 * en auditoría— y el tope de tres altas por minuto por IP lo vuelve
 * impracticable a escala. Está afirmado abajo para que no se lea como un olvido.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSignUpEmail, mockWriteAuditLog, mockRateLimit, mockTopePorIp } = vi.hoisted(
  () => ({
    mockSignUpEmail: vi.fn(),
    mockWriteAuditLog: vi.fn(),
    mockRateLimit: vi.fn(),
    mockTopePorIp: vi.fn(),
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

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new RedirigioA(destino);
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { signUpEmail: mockSignUpEmail } },
}));

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

/** Corre el alta y devuelve adónde redirigió, o el error que devolvió. */
async function darDeAlta(): Promise<{ destino?: string; error?: string }> {
  const { signUp } = await import("@/app/registro/actions");
  const fd = new FormData();
  fd.set("full_name", "Ana Pérez");
  fd.set("email", "ana@aseguradora.com");
  fd.set("password", "una-contraseña-larga-y-buena");
  fd.set("confirm_password", "una-contraseña-larga-y-buena");

  try {
    const r = (await signUp({}, fd)) as { error?: string };
    return { error: r?.error };
  } catch (e) {
    if (e instanceof RedirigioA) return { destino: e.destino };
    throw e;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
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
});

describe("el alta no distingue una dirección que ya existe", () => {
  it("una dirección con cuenta va al login con el aviso neutro", async () => {
    mockSignUpEmail.mockRejectedValue(
      new APIError("UNPROCESSABLE_ENTITY", {
        code: "USER_ALREADY_EXISTS",
        message: "User already exists",
      })
    );

    const r = await darDeAlta();

    expect(r.destino).toBe("/login?aviso=usa_tu_cuenta");
    // Y sobre todo: no vuelve un mensaje que lo cuente.
    expect(r.error).toBeUndefined();
  });

  it("un alta que se creó sin sesión va EXACTAMENTE al mismo lugar", async () => {
    // Es lo que hace que el de arriba no diga nada: si este cayera en otro
    // destino, la diferencia volvería a ser la respuesta.
    mockSignUpEmail.mockResolvedValue({ user: { id: "user-nuevo" }, token: null });

    const r = await darDeAlta();

    expect(r.destino).toBe("/login?aviso=usa_tu_cuenta");
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

  it("un fallo cualquiera del proveedor sí devuelve error, y uno genérico", async () => {
    // La otra mitad: si TODO redirigiera, no habría forma de saber que algo se
    // rompió de verdad.
    mockSignUpEmail.mockRejectedValue(new Error("la base se cayó"));

    const r = await darDeAlta();

    expect(r.destino).toBeUndefined();
    expect(r.error).toMatch(/no se pudo crear la cuenta/i);
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

    expect(r.destino).toBe("/login?aviso=usa_tu_cuenta");
    expect(r.error).toBeUndefined();
    // Y no se llega a crear nada: nadie ocupa una direccion ajena.
    expect(mockSignUpEmail).not.toHaveBeenCalled();
  });
});
