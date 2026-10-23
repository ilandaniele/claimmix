/**
 * Google entra sólo con `email_verified === true` en el perfil crudo.
 *
 * Para un proveedor de confianza Better Auth enlaza sin mirar esa marca, así
 * que una identidad de Google con el correo sin verificar se pegaba al usuario
 * existente con esa dirección y se llevaba su sesión. `user.validateUserInfo`
 * corre antes de cada alta, enlace e ingreso.
 *
 * Better Auth de verdad con `memoryAdapter` en lugar de Drizzle, igual que
 * `sesion-con-vencimiento.test.ts`.
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
  perfilDelIngreso: vi.fn(),
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

const fuente = (oauth?: { providerId: string; profile?: Record<string, unknown> }, method = "oauth") => ({
  action: "link-account" as const,
  method,
  oauth,
});
const validar = (user: Record<string, unknown>, source: ReturnType<typeof fuente>) =>
  Promise.resolve(auth.options.user!.validateUserInfo!({ user, source }));

describe("Google con el correo sin verificar", () => {
  it("existe el gancho", () => {
    expect(auth.options.user?.validateUserInfo).toBeTypeOf("function");
  });

  it.each([[{ email_verified: false }], [{ email_verified: undefined }], [{ email_verified: "true" }], [{ email_verified: 1 }], [undefined]])(
    "rechaza Google sin email_verified === true: %o",
    async (profile) => {
      await expect(validar({ email: "ana@example.com" }, fuente({ providerId: "google", profile }))).resolves.toEqual({
        error: "email_no_verificado",
      });
    },
  );

  it("deja pasar a Google con el correo verificado", async () => {
    await expect(
      validar(
        { email: "ana@example.com" },
        fuente({ providerId: "google", profile: { email: "ana@example.com", email_verified: true } }),
      ),
    ).resolves.toBeUndefined();
  });

  it("no toca el SSO ni el alta por contraseña", async () => {
    await expect(
      validar({}, fuente({ providerId: "sso:11111111-1111-4111-8111-111111111111" })),
    ).resolves.toBeUndefined();
    await expect(validar({}, fuente(undefined, "email-password"))).resolves.toBeUndefined();
  });
});
