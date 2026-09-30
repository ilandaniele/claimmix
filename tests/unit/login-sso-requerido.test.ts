/**
 * El login con contraseña cuando el dominio exige SSO (B19).
 *
 * El gancho de sesión frena a quien tiene la contraseña bien y su organización exige
 * el SSO. El `catch` del Server Action tragaba ese error y contestaba «Credenciales
 * inválidas.» con un AUTH_FAILURE: mandaba a probar otra contraseña a quien no se
 * había equivocado, y ensuciaba la auditoría con un fallo que no fue.
 */

import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  writeAuditLog: vi.fn(),
  rateLimit: vi.fn(),
  topePorIp: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }) }));
vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("@/lib/auth", () => ({ auth: { api: { signInEmail: m.signInEmail, signOut: vi.fn() } } }));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ tenant_id: "T1", role: "analyst" }] }) }) }) },
}));
vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: m.writeAuditLog,
}));
vi.mock("@/lib/rate-limit/index", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: m.rateLimit,
  topePorIp: m.topePorIp,
}));
vi.mock("@/server/sso/ingreso", () => ({ urlDelSso: vi.fn() }));

import { AuditEvent } from "@/lib/audit/log";
import { signIn } from "@/app/login/actions";

function formulario() {
  const f = new FormData();
  f.set("email", "pepe@empresa.com");
  f.set("password", "fake-clave-larga-y-unica-123");
  return f;
}

const eventos = () => m.writeAuditLog.mock.calls.map(([e]) => e.event_type);

beforeEach(() => {
  vi.clearAllMocks();
  m.rateLimit.mockResolvedValue({ allowed: true, remaining: 4, retryAfterSeconds: 0 });
  m.topePorIp.mockResolvedValue({ allowed: true, remaining: 40, retryAfterSeconds: 0 });
});

describe("signIn con «Exigir SSO»", () => {
  it("manda a /login con el código del SSO y no cuenta un fallo de credenciales", async () => {
    m.signInEmail.mockRejectedValue(new APIError("FORBIDDEN", { code: "sso_requerido", message: "Tu organización exige el SSO." }));

    await expect(signIn({}, formulario())).rejects.toThrow("NEXT_REDIRECT:/login?error=sso_requerido");

    expect(eventos()).not.toContain(AuditEvent.AUTH_FAILURE);
    expect(eventos()).not.toContain(AuditEvent.AUTH_SUCCESS);
  });

  it("una contraseña mala sigue diciendo «Credenciales inválidas.» y deja su AUTH_FAILURE", async () => {
    m.signInEmail.mockRejectedValue(new APIError("UNAUTHORIZED", { code: "INVALID_EMAIL_OR_PASSWORD", message: "x" }));

    await expect(signIn({}, formulario())).resolves.toEqual({ error: "Credenciales inválidas." });

    expect(eventos()).toEqual([AuditEvent.AUTH_FAILURE]);
    expect(m.redirect).not.toHaveBeenCalled();
  });

  it("otro APIError, o un error cualquiera, tampoco se confunde con el SSO", async () => {
    m.signInEmail.mockRejectedValueOnce(new APIError("FORBIDDEN", { code: "sso_otro_inquilino", message: "x" }));
    m.signInEmail.mockRejectedValueOnce(new Error("base caída"));

    await expect(signIn({}, formulario())).resolves.toEqual({ error: "Credenciales inválidas." });
    await expect(signIn({}, formulario())).resolves.toEqual({ error: "Credenciales inválidas." });

    expect(eventos()).toEqual([AuditEvent.AUTH_FAILURE, AuditEvent.AUTH_FAILURE]);
  });
});
