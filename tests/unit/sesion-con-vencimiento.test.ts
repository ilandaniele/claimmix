// @vitest-environment node
/**
 * La sesión vence a los treinta días del ingreso y no se renueva con el uso.
 *
 * Sin `expiresIn` ni `disableSessionRefresh`, Better Auth empuja `expiresAt` en
 * cada `getSession` y una sesión activa —o una cookie robada— no termina nunca.
 *
 * Better Auth de verdad con `memoryAdapter` en lugar de Drizzle, igual que
 * `sso-inquilino-flujo.test.ts`.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter({ user: [], session: [], account: [], verification: [] }) };
});
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn(), enTenantVarias: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: vi.fn(),
}));
vi.mock("@/server/sso/usuarios", () => ({
  duenoDelMail: vi.fn(),
  inquilinoDelUsuario: vi.fn(),
  dominioExigeSso: vi.fn(),
  correoExigeSso: vi.fn(),
}));
vi.mock("@/server/sso/config", async (original) => ({
  ...(await original<typeof import("@/server/sso/config")>()),
  configVigentePorDominio: vi.fn(),
  configVigenteDelInquilino: vi.fn(),
}));

let auth: typeof import("@/lib/auth").auth;

beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-key");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.test");
  ({ auth } = await import("@/lib/auth"));
});

describe("vencimiento de la sesión", () => {
  it("dura treinta días desde el ingreso", () => {
    expect(auth.options.session?.expiresIn).toBe(60 * 60 * 24 * 30);
  });

  it("no se renueva con el uso", () => {
    expect(auth.options.session?.disableSessionRefresh).toBe(true);
  });

  it("conserva la caché de sesión de sesenta segundos", () => {
    expect(auth.options.session?.cookieCache).toEqual({ enabled: true, maxAge: 60 });
  });
});
