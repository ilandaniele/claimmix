/**
 * El alta sin contraseña: qué hace `signUp` de /registro.
 *
 * Ya no pide contraseña ni deja sesión. Crea la cuenta con una contraseña al
 * azar que nadie conoce y manda el enlace de restablecimiento; la persona elige
 * la suya desde ahí. Todos los finales son el mismo redirect al login.
 *
 * Que dos finales no se distingan desde afuera es de `registro-no-enumera.test.ts`;
 * acá se prueba qué se le pide a Better Auth y qué queda asentado.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  signUpEmail: vi.fn(),
  requestPasswordReset: vi.fn(),
  findUserById: vi.fn(),
  writeAuditLog: vi.fn(),
  rateLimit: vi.fn(),
  topePorIp: vi.fn(),
  altaBloqueadaPorSso: vi.fn(),
  log: vi.fn(),
  /** Lo que el alta dejó para después de responder (`after`). */
  pendientes: [] as Array<() => unknown>,
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi
    .fn()
    .mockResolvedValue(new Headers({ "x-forwarded-for": "203.0.113.7", "user-agent": "test-agent" })),
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
    h.pendientes.push(tarea);
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new RedirigioA(destino);
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: { signUpEmail: h.signUpEmail, requestPasswordReset: h.requestPasswordReset },
    $context: Promise.resolve({ internalAdapter: { findUserById: h.findUserById } }),
  },
}));

vi.mock("@/server/sso/exigir", () => ({ altaBloqueadaPorSso: h.altaBloqueadaPorSso }));

vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: h.log, info: h.log, warn: h.log, error: h.log },
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: h.writeAuditLog,
  AuditEvent: { AUTH_SIGN_UP: "auth.sign_up", AUTH_RATE_LIMITED: "auth.rate_limited" },
}));

vi.mock("@/lib/rate-limit/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: h.rateLimit,
  topePorIp: h.topePorIp,
}));

import { APIError } from "better-auth/api";

import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { SignUpSchema } from "@/lib/schemas/auth";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const AVISO = "/login?aviso=revisa_tu_correo";
const LIBRE = { allowed: true, remaining: 2, resetAt: 0, retryAfterSeconds: 0 };
const AGOTADO = { allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 3600 };

async function darDeAlta(
  campos: Record<string, string> = { full_name: "Ana Pérez", email: "Ana@Example.com" }
): Promise<{ destino?: string; error?: string; fieldErrors?: Record<string, string[]> }> {
  const { signUp } = await import("@/app/registro/actions");
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  try {
    return await signUp({}, fd);
  } catch (e) {
    if (e instanceof RedirigioA) {
      // Lo que corre después de la respuesta: la lista, el alta, el mail.
      await Promise.all(h.pendientes.splice(0).map((tarea) => tarea()));
      return { destino: e.destino };
    }
    throw e;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.pendientes.length = 0;
  process.env.GOOGLE_DEFAULT_TENANT_ID = TENANT;
  process.env.SIGNUP_ALLOWED_EMAILS = "@example.com";
  h.rateLimit.mockResolvedValue(LIBRE);
  h.topePorIp.mockResolvedValue(LIBRE);
  h.altaBloqueadaPorSso.mockResolvedValue(false);
  h.writeAuditLog.mockResolvedValue(undefined);
  h.signUpEmail.mockResolvedValue({ user: { id: "user-nuevo" }, token: null });
  h.findUserById.mockResolvedValue({ id: "user-nuevo" });
  h.requestPasswordReset.mockResolvedValue({ status: true });
});

describe("el formulario no pide contraseña", () => {
  it("el esquema valida con nombre y correo, sin contraseña", () => {
    const r = SignUpSchema.safeParse({ full_name: "Ana Pérez", email: "Ana@Example.com" });

    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ full_name: "Ana Pérez", email: "ana@example.com" });
  });

  it("si llega una contraseña en el formulario, el esquema la descarta", () => {
    const r = SignUpSchema.safeParse({
      full_name: "Ana Pérez",
      email: "ana@example.com",
      password: "fake-password-1234",
    });

    expect(r.success && "password" in r.data).toBe(false);
  });

  it("sin contraseña en el FormData el alta sigue de largo", async () => {
    const r = await darDeAlta();

    expect(r.fieldErrors).toBeUndefined();
    expect(h.signUpEmail).toHaveBeenCalledTimes(1);
  });

  it("un correo inválido vuelve con el error del campo y no toca a Better Auth", async () => {
    const r = await darDeAlta({ full_name: "Ana Pérez", email: "no-es-un-correo" });

    expect(r.fieldErrors?.email).toBeDefined();
    expect(h.signUpEmail).not.toHaveBeenCalled();
    expect(h.requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe("el alta de una dirección habilitada", () => {
  it("crea la cuenta con una contraseña al azar de 64 hex, sin cookies", async () => {
    await darDeAlta();

    const { body, headers } = h.signUpEmail.mock.calls[0]![0];
    expect(body.name).toBe("Ana Pérez");
    expect(body.email).toBe("ana@example.com");
    expect(body.password).toMatch(/^[0-9a-f]{64}$/);
    // Cabeceras vacías: nada de cookies, el alta no abre sesión.
    expect([...(headers as Headers).keys()]).toEqual([]);
  });

  it("cada alta usa una contraseña distinta", async () => {
    await darDeAlta();
    await darDeAlta();

    const [a, b] = h.signUpEmail.mock.calls.map((c) => c[0].body.password);
    expect(a).not.toBe(b);
  });

  it("manda el enlace de restablecimiento a la dirección y termina en el aviso", async () => {
    const r = await darDeAlta();

    expect(h.requestPasswordReset).toHaveBeenCalledTimes(1);
    expect(h.requestPasswordReset.mock.calls[0]![0].body).toEqual({
      email: "ana@example.com",
      redirectTo: "/restablecer",
    });
    expect(r.destino).toBe(AVISO);
  });

  it("deja asentada el alta, sin actor (la cuenta todavía no tiene perfil)", async () => {
    await darDeAlta();

    expect(h.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(h.writeAuditLog.mock.calls[0]![0]).toMatchObject({
      tenant_id: TENANT,
      actor_id: null,
      event_type: "auth.sign_up",
      target_type: "user",
      target_id: "user-nuevo",
      payload: { role: "analyst", self_registered: true },
    });
  });
});

describe("una dirección que ya tenía cuenta", () => {
  it("USER_ALREADY_EXISTS no corta: manda el enlace, no audita el alta y redirige igual", async () => {
    h.signUpEmail.mockRejectedValue(
      new APIError("UNPROCESSABLE_ENTITY", { code: "USER_ALREADY_EXISTS", message: "User already exists" })
    );

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
    expect(h.requestPasswordReset).toHaveBeenCalledTimes(1);
    expect(h.writeAuditLog).not.toHaveBeenCalled();
  });

  it("la respuesta de mentira de Better Auth (usuario que no está en la base) no audita", async () => {
    h.signUpEmail.mockResolvedValue({ user: { id: "usuario-de-mentira" }, token: null });
    h.findUserById.mockResolvedValue(null);

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
    expect(h.requestPasswordReset).toHaveBeenCalledTimes(1);
    expect(h.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("el cupo del mail es el mismo de /recuperar", () => {
  it("pide auth:reset con IP y correo, y la misma configuración", async () => {
    await darDeAlta();

    expect(h.rateLimit).toHaveBeenCalledWith("auth:up:203.0.113.7", RATE_LIMIT_CONFIGS.AUTH_SIGN_UP);
    expect(h.rateLimit).toHaveBeenCalledWith(
      "auth:reset:203.0.113.7:ana@example.com",
      RATE_LIMIT_CONFIGS.AUTH_RESET
    );
    expect(h.topePorIp).toHaveBeenCalledWith("203.0.113.7");
  });

  it("gasta el cupo aunque la dirección no esté habilitada o su dominio exija SSO", async () => {
    // Si sólo lo gastaran las habilitadas, /api/auth/request-password-reset (misma
    // clave, 429 al agotarse) diría desde afuera cuáles están en la lista.
    const clave = "auth:reset:203.0.113.7:ana@example.com";
    const gastos = () => h.rateLimit.mock.calls.filter(([c]) => c === clave).length;

    await darDeAlta();
    const habilitada = gastos();

    process.env.SIGNUP_ALLOWED_EMAILS = "@otra-empresa.com";
    h.rateLimit.mockClear();
    await darDeAlta();
    const fueraDeLaLista = gastos();

    process.env.SIGNUP_ALLOWED_EMAILS = "@example.com";
    h.altaBloqueadaPorSso.mockResolvedValue(true);
    h.rateLimit.mockClear();
    await darDeAlta();
    const conSso = gastos();

    expect(habilitada).toBe(1);
    expect(fueraDeLaLista).toBe(habilitada);
    expect(conSso).toBe(habilitada);
  });

  it("con el cupo agotado no manda el enlace, pero termina en el mismo aviso", async () => {
    h.rateLimit.mockImplementation(async (clave: string) =>
      clave.startsWith("auth:reset:") ? AGOTADO : LIBRE
    );

    const r = await darDeAlta();

    expect(h.requestPasswordReset).not.toHaveBeenCalled();
    expect(r.destino).toBe(AVISO);
    expect(r.error).toBeUndefined();
  });

  it("con el cupo de altas agotado devuelve el error de siempre y no crea nada", async () => {
    h.rateLimit.mockImplementation(async (clave: string) =>
      clave.startsWith("auth:up:") ? AGOTADO : LIBRE
    );

    const r = await darDeAlta();

    expect(r.error).toMatch(/demasiados intentos/i);
    expect(h.signUpEmail).not.toHaveBeenCalled();
    expect(h.requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe("lo que falla sin que se vea", () => {
  it("si el envío del enlace tira, igual termina en el aviso", async () => {
    h.requestPasswordReset.mockRejectedValue(new Error("la casilla no responde"));

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
    expect(r.error).toBeUndefined();
  });

  it("si no se puede asentar el alta, igual termina en el aviso", async () => {
    h.findUserById.mockRejectedValue(new Error("connection terminated"));

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
    expect(h.requestPasswordReset).toHaveBeenCalledTimes(1);
  });

  it("si la base falla al mirar la lista, deja la línea de log y no tira dentro de after()", async () => {
    h.altaBloqueadaPorSso.mockRejectedValue(new Error("connection terminated"));

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
    expect(h.signUpEmail).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith({ detalle: "Error" }, "registro.alta_no_terminada");
  });

  it("si la base falla al contar el cupo del mail, deja la línea de log y no tira dentro de after()", async () => {
    h.rateLimit.mockImplementation(async (clave: string) => {
      if (clave.startsWith("auth:reset:")) throw new Error("connection terminated");
      return LIBRE;
    });

    const r = await darDeAlta();

    expect(r.destino).toBe(AVISO);
    expect(h.requestPasswordReset).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith({ detalle: "Error" }, "registro.alta_no_terminada");
  });

  it("sin inquilino por omisión devuelve el error de siempre", async () => {
    delete process.env.GOOGLE_DEFAULT_TENANT_ID;
    delete process.env.DEFAULT_TENANT_ID;
    delete process.env.GMAIL_TENANT_ID;

    const r = await darDeAlta();

    expect(r.error).toMatch(/registro no está habilitado/i);
    expect(h.signUpEmail).not.toHaveBeenCalled();
  });
});
