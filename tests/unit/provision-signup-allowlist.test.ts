/**
 * Quién recibe perfil al crearse una cuenta — the tenant's front door.
 *
 * Google sign-in and the email signup both funnel through provisionUserProfile.
 * It used to drop any allowed address into GOOGLE_DEFAULT_TENANT_ID (the
 * production tenant, with real claims) as an "analyst". Now no new account ever
 * lands there: only the member who arrives by their company's SSO (viewer of
 * that tenant) and the product operator (ADMIN_EMAILS, verified, admin of the
 * platform tenant) get a profile. Everyone else stays without one and follows
 * to /alta, which creates their own space.
 *
 * The profile row IS tenant membership: withholding it leaves the account with
 * no tenant, so pages redirect and APIs 401. These tests pin that behaviour.
 */

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: hay tests que
// intercambian la base simulada entre casos, y un `const { db } = ...`
// congelaría el valor de la primera.
vi.mock("@/data/scope", () => import("../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  tables: {},
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { provisionUserProfile } from "@/lib/auth/provision";
import { enIngresoPorSso } from "@/lib/auth/registro-permitido";
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

describe("provisionUserProfile — sin perfil en el inquilino por omisión", () => {
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

  it("una dirección de SIGNUP_ALLOWED_EMAILS, verificada, ya no recibe perfil: va a /alta", async () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "analista@aseguradora.com";
    const values = mockInsert();

    await provisionUserProfile({ id: "u3", name: "Ana", email: "Analista@Aseguradora.com", emailVerified: true });

    expect(values).not.toHaveBeenCalled();
  });

  it("un dominio entero de la lista tampoco recibe perfil", async () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "@aseguradora.com";
    const values = mockInsert();

    await provisionUserProfile({ id: "u4", name: "Bruno", email: "bruno@aseguradora.com", emailVerified: true });

    expect(values).not.toHaveBeenCalled();
  });

  it("con el alta automática prendida, una cuenta nueva común queda sin perfil", async () => {
    process.env.ALTA_AUTOMATICA = "1";
    const values = mockInsert();

    await provisionUserProfile({ id: "u5", name: "Eva", email: "eva@example.com", emailVerified: true });

    expect(values).not.toHaveBeenCalled();
  });

  it("el operador de ADMIN_EMAILS, con el mail verificado, queda admin del inquilino de la plataforma", async () => {
    process.env.ADMIN_EMAILS = "jefe@veltra.com";
    const values = mockInsert();

    await provisionUserProfile({
      id: "u6",
      name: "Jefe",
      email: "Jefe@Veltra.com",
      emailVerified: true,
    });

    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: "u6", tenant_id: TENANT, role: "admin" }));
  });

  it("refuses an operator address that has not been proven", async () => {
    /**
     * requireEmailVerification is false on the password path, so the address is
     * simply what the person typed. Anyone who guessed an operator address that
     * had not registered yet could take it and become admin of the platform.
     * Google sign-in proves the address, so the intended path is unaffected.
     */
    process.env.ADMIN_EMAILS = "jefe@veltra.com";
    const values = mockInsert();

    await provisionUserProfile({ id: "u7", name: "Mallory", email: "jefe@veltra.com" });

    expect(values).not.toHaveBeenCalled();
  });

  it("sin inquilino de la plataforma configurado, el operador no queda a medias: falla fuerte", async () => {
    process.env.ADMIN_EMAILS = "jefe@veltra.com";
    delete process.env.GOOGLE_DEFAULT_TENANT_ID;
    delete process.env.DEFAULT_TENANT_ID;
    delete process.env.GMAIL_TENANT_ID;
    const values = mockInsert();

    await expect(
      provisionUserProfile({ id: "u9", name: "Jefe", email: "jefe@veltra.com", emailVerified: true })
    ).rejects.toThrow(/GOOGLE_DEFAULT_TENANT_ID/);
    expect(values).not.toHaveBeenCalled();
  });

  it("still skips work when the profile already exists (idempotent hook)", async () => {
    process.env.ADMIN_EMAILS = "jefe@veltra.com";
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: "u7" }]) }),
      }),
    });
    const values = mockInsert();

    await provisionUserProfile({ id: "u7", name: "Ya", email: "jefe@veltra.com", emailVerified: true });

    expect(values).not.toHaveBeenCalled();
  });
});

describe("provisionUserProfile — alta por el SSO de un inquilino", () => {
  const env = { ...process.env };
  const T_SSO = "20000000-0000-4000-8000-000000000002";
  const ingreso = { tenantId: T_SSO, dominio: "empresa.com" };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_DEFAULT_TENANT_ID = TENANT;
    delete process.env.ADMIN_EMAILS;
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    mockNoExistingProfile();
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it("crea un viewer en el inquilino del state, no en el de omisión", async () => {
    const values = mockInsert();

    await enIngresoPorSso(ingreso, () =>
      provisionUserProfile({ id: "u1", name: "Ana", email: "ana@empresa.com", emailVerified: true })
    );

    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1", tenant_id: T_SSO, role: "viewer", full_name: "Ana" })
    );
  });

  it("una dirección de operador no queda en el espacio de una aseguradora: sin perfil", async () => {
    // El operador vive en la plataforma. Que su dirección apareciera como
    // miembro (aunque fuera viewer) de otra organización la dejaría de hacer
    // sólo nuestra.
    process.env.ADMIN_EMAILS = "ana@empresa.com";
    const values = mockInsert();

    await enIngresoPorSso(ingreso, () =>
      provisionUserProfile({ id: "u1", name: "Ana", email: "ana@empresa.com", emailVerified: true })
    );

    expect(values).not.toHaveBeenCalled();
  });

  it("nunca admin: otro miembro del dominio, con ADMIN_EMAILS en uso, sigue siendo viewer", async () => {
    process.env.ADMIN_EMAILS = "jefe@veltra.com";
    const values = mockInsert();

    await enIngresoPorSso(ingreso, () =>
      provisionUserProfile({ id: "u2", name: "Beto", email: "beto@empresa.com", emailVerified: true })
    );

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ role: "viewer", tenant_id: T_SSO }));
  });

  it("sin el mail verificado no hay perfil", async () => {
    const values = mockInsert();

    await enIngresoPorSso(ingreso, () =>
      provisionUserProfile({ id: "u1", name: "Ana", email: "ana@empresa.com", emailVerified: false })
    );

    expect(values).not.toHaveBeenCalled();
  });

  it("un mail de otro dominio no recibe perfil, aunque esté en la allowlist de siempre", async () => {
    process.env.SIGNUP_ALLOWED_EMAILS = "@otra.com";
    const values = mockInsert();

    await enIngresoPorSso(ingreso, () =>
      provisionUserProfile({ id: "u1", name: "Eva", email: "eva@otra.com", emailVerified: true })
    );

    expect(values).not.toHaveBeenCalled();
  });

  it("si el perfil ya existe no toca nada", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: "u1" }]) }),
      }),
    });
    const values = mockInsert();

    await enIngresoPorSso(ingreso, () =>
      provisionUserProfile({ id: "u1", name: "Ana", email: "ana@empresa.com", emailVerified: true })
    );

    expect(values).not.toHaveBeenCalled();
  });

  it("fuera del SSO, el mismo mail no recibe perfil en ninguna parte", async () => {
    const values = mockInsert();

    await provisionUserProfile({ id: "u1", name: "Ana", email: "ana@empresa.com", emailVerified: true });

    expect(values).not.toHaveBeenCalled();
  });
});
