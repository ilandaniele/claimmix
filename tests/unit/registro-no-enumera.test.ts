/**
 * El alta no dice si una dirección ya tiene cuenta.
 *
 * Decía «Ya existe una cuenta con ese correo. Iniciá sesión», y con eso
 * alcanzaba para averiguar quién trabaja en la aseguradora: se prueban
 * direcciones y se lee la respuesta. Es la enumeración de usuarios del manual, y
 * en un producto B2B lo que revela es el padrón de empleados.
 *
 * TODOS los finales de `signUp` terminan en el mismo lugar y sin devolver nada
 * (/login?aviso=revisa_tu_correo): la dirección ya tenía cuenta, es nueva, no
 * está habilitada, es de operación, su dominio exige SSO, el mail no salió o la
 * base se cayó. Lo que cambia —el mail que le llega a su dueña— no se ve desde
 * afuera.
 *
 * Y tampoco por el tiempo: la base, la lista y el mail corren en `after`, con la
 * respuesta ya enviada, así que una dirección habilitada no tarda más que una
 * que no lo está. Y `signUp` no crea nada: nunca llama a `signUpEmail`, que
 * contestaba distinto según la dirección existiera o no.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  signUpEmail: vi.fn(),
  buscar: vi.fn(),
  escribir: vi.fn(),
  rateLimit: vi.fn(),
  topePorIp: vi.fn(),
  dominioExigeSso: vi.fn(),
  enviar: vi.fn(),
  /** Lo que el alta dejó para después de responder (`after`). */
  pendientes: [] as Array<() => unknown>,
}));

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
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (tarea: () => unknown) => {
    h.pendientes.push(tarea);
  },
}));

vi.mock("@/lib/auth", () => ({ auth: { api: { signUpEmail: h.signUpEmail } } }));
vi.mock("@/lib/auth/require-operator", () => ({
  isOperatorEmail: (e: string | null | undefined) => e === "ops@example.com",
}));
// La base sólo sabe leer: cualquier escritura quedaría anotada en `escribir`.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: h.buscar }) }) }),
    insert: h.escribir,
    update: h.escribir,
    delete: h.escribir,
    execute: h.escribir,
  },
}));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: vi.fn().mockResolvedValue("es-AR") }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/rate-limit/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: h.rateLimit,
  topePorIp: h.topePorIp,
}));
vi.mock("@/server/notify/remitente-sistema", () => ({ enviarCorreoDelSistema: h.enviar }));
vi.mock("@/server/sso/usuarios", () => ({ dominioExigeSsoEnAlgunInquilino: h.dominioExigeSso }));

const AVISO = "/login?aviso=revisa_tu_correo";
const LIBRE = { allowed: true, remaining: 2, resetAt: 0, retryAfterSeconds: 0 };

const BUENOS = {
  empresa: "Seguros del Sur",
  whatsapp: "+5492916426930",
  terminos: "on",
  full_name: "Ana Pérez",
  email: "ana@aseguradora.example.com",
};

/** Corre lo que el alta dejó para después de responder. */
const correrLoDiferido = () => Promise.all(h.pendientes.splice(0).map((tarea) => tarea()));

/**
 * Corre `signUp` y devuelve adónde redirigió, y lo que devolvió si no redirigió.
 * Con `diferido: false` no corre lo que quedó para después de la respuesta.
 */
async function darDeAlta(
  campos: Record<string, string> = BUENOS,
  diferido = true
): Promise<{ destino?: string; devolvio?: unknown }> {
  const { signUp } = await import("@/app/registro/actions");
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);

  try {
    return { devolvio: await signUp(fd) };
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
  h.pendientes.length = 0;
  process.env.BETTER_AUTH_SECRET = "fake-secreto-del-registro-0123456789";
  process.env.NEXT_PUBLIC_SITE_URL = "https://app.example.com";
  process.env.ALTA_AUTOMATICA = "1";
  delete process.env.SIGNUP_ALLOWED_EMAILS;
  delete process.env.ADMIN_EMAILS;
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  h.rateLimit.mockResolvedValue(LIBRE);
  h.topePorIp.mockResolvedValue(LIBRE);
  h.buscar.mockResolvedValue([]);
  h.dominioExigeSso.mockResolvedValue(false);
  h.enviar.mockResolvedValue({ enviado: true });
});

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.ALTA_AUTOMATICA;
});

/*
 * Un caso por final posible. Si alguno cayera en otro destino, o devolviera algo,
 * la diferencia volvería a ser la respuesta y alcanzaría con probar direcciones.
 */
const FINALES: Array<[string, () => void, Record<string, string>?]> = [
  ["una dirección nueva", () => {}],
  ["una dirección que ya tiene cuenta", () => h.buscar.mockResolvedValue([{ id: "u-1" }])],
  ["con el alta cerrada para la dirección", () => {
    delete process.env.ALTA_AUTOMATICA;
    process.env.SIGNUP_ALLOWED_EMAILS = "@otra-empresa.example.com";
  }],
  ["una dirección de operación", () => {}, { ...BUENOS, email: "ops@example.com" }],
  ["un dominio que exige SSO", () => h.dominioExigeSso.mockResolvedValue(true)],
  ["sin remitente del sistema", () => h.enviar.mockResolvedValue({ enviado: false, motivo: "sin_remitente" })],
  ["sin cupo de mails", () => h.enviar.mockResolvedValue({ enviado: false, motivo: "sin_cupo" })],
  ["un mail que no salió", () => h.enviar.mockResolvedValue({ enviado: false, motivo: "no_salio" })],
  ["la base caída", () => h.buscar.mockRejectedValue(new Error("la base se cayó"))],
];

describe("signUp no distingue una dirección que ya existe", () => {
  it.each(FINALES)("%s va al login con el aviso neutro, sin devolver nada", async (_caso, preparar, campos) => {
    preparar();

    const r = await darDeAlta(campos);

    expect(r).toEqual({ destino: AVISO });
  });

  it("y ningún final deja una fila ni llama a signUpEmail", async () => {
    for (const [, preparar, campos] of FINALES) {
      vi.clearAllMocks();
      h.rateLimit.mockResolvedValue(LIBRE);
      h.topePorIp.mockResolvedValue(LIBRE);
      h.buscar.mockResolvedValue([]);
      h.dominioExigeSso.mockResolvedValue(false);
      h.enviar.mockResolvedValue({ enviado: true });
      process.env.ALTA_AUTOMATICA = "1";
      delete process.env.SIGNUP_ALLOWED_EMAILS;
      preparar();

      await darDeAlta(campos);

      expect(h.signUpEmail).not.toHaveBeenCalled();
      expect(h.escribir).not.toHaveBeenCalled();
    }
  });

  it("ningún final devuelve un mensaje que hable de cuentas existentes", async () => {
    h.buscar.mockResolvedValue([{ id: "u-1" }]);

    const r = await darDeAlta();

    expect(JSON.stringify(r)).not.toMatch(/ya existe|already|ya ten[eé]s/i);
  });
});

describe("signUp no se distingue por el tiempo", () => {
  it("responde antes de preguntar por la cuenta, de mirar la lista y de mandar el mail", async () => {
    // Lo que tarda es lo que distinguiría a una dirección habilitada de otra: la
    // base, la lista y el envío. Nada de eso corre antes de la respuesta.
    const r = await darDeAlta(BUENOS, false);

    expect(r).toEqual({ destino: AVISO });
    expect(h.buscar).not.toHaveBeenCalled();
    expect(h.dominioExigeSso).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.pendientes).toHaveLength(1);

    await correrLoDiferido();

    expect(h.buscar).toHaveBeenCalledTimes(1);
    expect(h.enviar).toHaveBeenCalledTimes(1);
  });

  it("una dirección que ya tiene cuenta deja lo mismo para después que una nueva", async () => {
    h.buscar.mockResolvedValue([{ id: "u-1" }]);
    await darDeAlta(BUENOS, false);
    const conCuenta = h.pendientes.length;
    h.pendientes.length = 0;

    h.buscar.mockResolvedValue([]);
    await darDeAlta(BUENOS, false);

    expect(h.pendientes).toHaveLength(conCuenta);
  });
});
