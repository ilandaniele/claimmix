/**
 * Signup allowlist — the tenant's front door.
 *
 * /registro is a public route and Google sign-in is open; both funnel through
 * provisionUserProfile. Before the allowlist, any new account was dropped into
 * GOOGLE_DEFAULT_TENANT_ID as an "analyst", and since /bandeja only checks for
 * a session and GET /api/cases accepts ALL_ROLES, a stranger who registered
 * could read every claim in the production tenant (names, DNI, policy numbers).
 *
 * The profile row IS tenant membership: withholding it leaves the account with
 * no tenant, so pages redirect and APIs 401. These tests pin that behaviour.
 */

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  tables: {},
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { provisionUserProfile } from "@/lib/auth/provision";
import { db } from "@/lib/db";

const TENANT = "10000000-0000-0000-0000-000000000001";

/** db.select(...).from(...).where(...).limit() → no existing profile row. */
function mockNoExistingProfile() {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
    }),
  });
}

function mockInsert() {
  const values = vi.fn().mockResolvedValue(undefined);
  (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values });
  return values;
}

describe("provisionUserProfile — signup allowlist", () => {
  const env = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_DEFAULT_TENANT_ID = TENANT;
    delete process.env.ADMIN_EMAILS;
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    mockNoExistingProfile();
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it("refuses a stranger: no profile row, so no tenant and no claim access", async () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "analista@aseguradora.com";
    const values = mockInsert();

    await provisionUserProfile({ id: "u1", name: "Mallory", email: "mallory@evil.test" });

    expect(values).not.toHaveBeenCalled();
  });

  it("is closed by default — an unconfigured deploy grants nothing", async () => {
    const values = mockInsert();

    await provisionUserProfile({ id: "u2", name: "Nobody", email: "someone@gmail.com" });

    expect(values).not.toHaveBeenCalled();
  });

  it("admits an allowlisted address", async () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "analista@aseguradora.com";
    const values = mockInsert();

    await provisionUserProfile({ id: "u3", name: "Ana", email: "Analista@Aseguradora.com" });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u3", tenant_id: TENANT, role: "analyst" })
    );
  });

  it("admits a whole domain via @domain, for onboarding an insurer's staff", async () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "@aseguradora.com";
    const values = mockInsert();

    await provisionUserProfile({ id: "u4", name: "Bruno", email: "bruno@aseguradora.com" });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: "u4" }));
  });

  it("does not let an @domain entry match a lookalike suffix", async () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "@aseguradora.com";
    const values = mockInsert();

    await provisionUserProfile({ id: "u5", name: "Evil", email: "evil@notaseguradora.com" });

    expect(values).not.toHaveBeenCalled();
  });

  it("treats ADMIN_EMAILS as allowed, so configured admins keep signing in", async () => {
    process.env.ADMIN_EMAILS = "jefe@veltra.com";
    const values = mockInsert();

    // emailVerified stays false here (password signup), so the admin role is
    // NOT granted — but the account is still admitted to the tenant.
    await provisionUserProfile({ id: "u6", name: "Jefe", email: "jefe@veltra.com" });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: "u6", role: "analyst" }));
  });

  it("still skips work when the profile already exists (idempotent hook)", async () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "@aseguradora.com";
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: "u7" }]) }),
      }),
    });
    const values = mockInsert();

    await provisionUserProfile({ id: "u7", name: "Ya", email: "ya@aseguradora.com" });

    expect(values).not.toHaveBeenCalled();
  });
});
