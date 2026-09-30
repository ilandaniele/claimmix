/**
 * Integration-style unit tests for POST /api/cases/:id/sync-to-core.
 *
 * AC17: CoreSyncService mock triggered on POST /api/cases/:id/sync-to-core.
 *   - listo_para_core → enviado_a_core (mock success)
 *   - Mock failure → error_core + errorMessage stored
 *   - Wrong status → 400 FSM_INVALID_TRANSITION
 *   - Wrong role → 403 FORBIDDEN_ROLE
 *
 * Note: True integration tests require INTEGRATION_ENABLED=true and a live DB.
 * These tests mock @/lib/db (Drizzle) and @/lib/auth/require-role directly.
 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/data/scope", () => import("../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

/*
 * La sesión, que ahora la ruta mira antes que nada.
 *
 * `entrar()` la pide una sola vez y con ella lanza EN PARALELO la fila de
 * `users` y el cupo: las dos necesitan el id del usuario y nada más. Antes iban
 * en fila, tres viajes a Neon antes del primer byte útil.
 *
 * Acá se simula porque el mock de `require-role` ya no la arrastra: la lectura
 * de la sesión salió de adentro suyo.
 */
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
  ALL_ROLES: ["owner", "admin", "specialist", "analyst", "viewer"],
  TRAINING_APPROVER_ROLES: ["owner", "admin", "specialist"],
  ADMIN_ROLES: ["owner", "admin"],
  CASE_EDITOR_ROLES: ["owner", "admin", "specialist", "analyst"],
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    CORE_SYNC_SUCCESS: "core.sync_success",
    CORE_SYNC_FAILED: "core.sync_failed",
  },
}));

/*
 * El cliente real, sin red: lo que se prueba acá es qué hace la ruta con cada
 * resultado. La firma, el destino y el socket tienen sus propios tests.
 */
const real = vi.hoisted(() => ({ syncCase: vi.fn(), configs: [] as unknown[] }));
vi.mock("@/server/core-sync/real", () => ({
  RealCoreSyncClient: class {
    syncCase = real.syncCase;
    constructor(config: unknown) {
      real.configs.push(config);
    }
  },
}));

vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: Date.now() + 60000,
    retryAfterSeconds: 0,
  }),
  RATE_LIMIT_CONFIGS: {
    SYNC_TO_CORE: { limit: 5, windowMs: 60000 },
  },
  buildUserKey: (uid: string, ep: string) => `user:${uid}:${ep}`,
  getClientIp: () => "127.0.0.1",
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_CASE_ID = "123e4567-e89b-12d3-a456-426614174001"; // does NOT end in '0' → mock success
const FAILING_CASE_ID = "123e4567-e89b-12d3-a456-426614174000"; // ends in '0' → mock failure

function makeRequest(body: unknown = {}, caseId = VALID_CASE_ID) {
  return new Request(`http://localhost/api/cases/${caseId}/sync-to-core`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

function makeContext(caseId = VALID_CASE_ID) {
  return { params: Promise.resolve({ id: caseId }) };
}

const DEFAULT_USER_ROW = { id: "user-1", tenant_id: "tenant-1", role: "admin" as const, plan: "piloto" };

const DEFAULT_CASE_ROW = {
  id: VALID_CASE_ID,
  status: "listo_para_core",
  tenant_id: "tenant-1",
  claim_type: "choque",
  severity: "low",
  policy_number: "POL-2024-001",
  policyholder_name: "Juan Pérez",
  customer_id: null,
  policy_id: null,
};

const DEFAULT_EXTRACTED_FIELDS = [
  { field_key: "accident_date", field_value: "2024-01-15" },
  { field_key: "accident_description", field_value: "Choque en Av. Cabildo" },
];

/**
 * Las lecturas que hace la ruta antes de llamar al cliente, en el orden del
 * lote: el caso, sus campos extraidos y —fuera del mock— la fila de
 * `core_sync_settings`. Usa un contador (`n`) que arranca de nuevo en cada
 * llamada a `db.select.mockImplementation`.
 *
 * `config` es la fila de la aseguradora (vacía = sin fila), o un error para
 * simular la 0036 sin aplicar.
 *
 * Devuelve el espia de `update` para poder afirmar que NO se llamo.
 */
function montarLecturaDelCaso(db: any, caseRow: unknown = DEFAULT_CASE_ROW, config: unknown[] | Error = []) {
  let n = 0;
  db.select.mockImplementation(() => {
    n += 1;
    if (n === 1) {
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([caseRow]),
          }),
        }),
      };
    }
    if (n === 3) {
      return {
        from: config instanceof Error ? vi.fn().mockRejectedValue(config) : vi.fn().mockResolvedValue(config),
      };
    }
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(DEFAULT_EXTRACTED_FIELDS),
      }),
    };
  });

  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: VALID_CASE_ID }]),
      }),
    }),
  });
  db.update.mockImplementation(update);
  return update;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/cases/:id/sync-to-core", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    /*
     * El simulador hay que pedirlo por su nombre.
     *
     * Antes `getCoreSyncClient()` lo devolvía con `CORE_SYNC_MODE` sin definir,
     * que es exactamente como corría en producción: el botón contestaba que sí
     * y guardaba un identificador inventado. Ahora el default es no tener
     * cliente, así que los casos de abajo —que prueban el simulador— lo piden.
     */
    vi.stubEnv("CORE_SYNC_MODE", "mock");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("listo_para_core → enviado_a_core (mock success)", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([DEFAULT_CASE_ROW]),
            }),
          }),
        } as any;
      }
      // extracted_fields
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(DEFAULT_EXTRACTED_FIELDS),
        }),
      } as any;
    });

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: VALID_CASE_ID }]),
        }),
      }),
    } as any);

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.synced).toBe(true);
    expect(body.externalId).toMatch(/^CORE-/);
  });

  it("AC17: logs CORE_SYNC_SUCCESS on success", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");
    const { writeAuditLog } = await import("@/lib/audit/log");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([DEFAULT_CASE_ROW]),
            }),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(DEFAULT_EXTRACTED_FIELDS),
        }),
      } as any;
    });

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: VALID_CASE_ID }]),
        }),
      }),
    } as any);

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    await POST(makeRequest(), makeContext(VALID_CASE_ID));

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "core.sync_success",
        target_id: VALID_CASE_ID,
      })
    );
  });

  it("mock failure (caseId ends in 0) → error_core + errorMessage returned", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    });

    const failingCaseRow = {
      id: FAILING_CASE_ID,
      status: "listo_para_core",
      tenant_id: "tenant-1",
      claim_type: "choque",
      severity: "medium",
      policy_number: null,
      policyholder_name: null,
      customer_id: null,
      policy_id: null,
    };

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([failingCaseRow]),
            }),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(DEFAULT_EXTRACTED_FIELDS),
        }),
      } as any;
    });

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: FAILING_CASE_ID }]),
        }),
      }),
    } as any);

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(FAILING_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.synced).toBe(false);
    expect(body.errorMessage).toBe("timeout");
  });

  it("AC17: logs CORE_SYNC_FAILED on mock failure", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");
    const { writeAuditLog } = await import("@/lib/audit/log");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    });

    const failingCaseRow = {
      id: FAILING_CASE_ID,
      status: "listo_para_core",
      tenant_id: "tenant-1",
      claim_type: "choque",
      severity: "medium",
      policy_number: null,
      policyholder_name: null,
      customer_id: null,
      policy_id: null,
    };

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([failingCaseRow]),
            }),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(DEFAULT_EXTRACTED_FIELDS),
        }),
      } as any;
    });

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: FAILING_CASE_ID }]),
        }),
      }),
    } as any);

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    await POST(makeRequest(), makeContext(FAILING_CASE_ID));

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "core.sync_failed",
        target_id: FAILING_CASE_ID,
      })
    );
  });

  it("wrong status → 409 FSM_INVALID_TRANSITION", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    });

    const wrongStatusCaseRow = {
      id: VALID_CASE_ID,
      status: "recibido", // wrong status — must be listo_para_core
      tenant_id: "tenant-1",
      claim_type: "choque",
      severity: null,
      policy_number: null,
      policyholder_name: null,
      customer_id: null,
      policy_id: null,
    };

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([wrongStatusCaseRow]),
        }),
      }),
    } as any);

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("FSM_INVALID_TRANSITION");
  });

  it("wrong role → 403 FORBIDDEN_ROLE", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { AppError } = await import("@/lib/errors");

    // requireRole throws FORBIDDEN_ROLE for analyst role
    vi.mocked(requireRole).mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
  });

  it("admite los mismos roles que ven el botón del caso", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { AppError } = await import("@/lib/errors");
    const { CORE_SYNC_ROLES } = await import("@/lib/auth/roles");
    vi.mocked(requireRole).mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    const { POST } = await import("@/app/api/cases/[id]/sync-to-core/route");
    await POST(makeRequest(), makeContext(VALID_CASE_ID));

    expect(requireRole).toHaveBeenCalledWith(...CORE_SYNC_ROLES);
    expect(CORE_SYNC_ROLES).toContain("owner");
  });

  it("AC19: returns 404 for non-existent / wrong-tenant case", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    });

    // No rows returned — cross-tenant case
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 401 when unauthenticated", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { AppError } = await import("@/lib/errors");

    vi.mocked(requireRole).mockRejectedValue(new AppError("MISSING_SESSION"));

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));

    expect(response.status).toBe(401);
  });

  /*
   * El caso que importa: sin integración configurada NO se inventa nada.
   *
   * Esto es lo que corría en producción. `CORE_SYNC_MODE` no está puesta ni en
   * `.env.local`, ni en la CI, ni en Vercel, y la fábrica devolvía el simulador
   * igual: el caso terminaba en `enviado_a_core` con un `core_external_id`
   * armado con los primeros ocho caracteres del id, y la auditoría guardaba un
   * CORE_SYNC_SUCCESS de algo que no pasó.
   *
   * Se afirma sobre las tres consecuencias por separado —el código, que no se
   * escribió el caso, y que no se auditó un éxito— porque cada una se puede
   * romper sin las otras.
   */
  it("sin integración configurada: 501, y el caso queda intacto", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");
    const { writeAuditLog } = await import("@/lib/audit/log");

    vi.stubEnv("CORE_SYNC_MODE", "");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    } as never);

    const update = montarLecturaDelCaso(db);

    const { POST } = await import("@/app/api/cases/[id]/sync-to-core/route");
    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body.error.code).toBe("NOT_IMPLEMENTED");

    // Ni el estado ni el identificador: no se tocó la fila.
    expect(update).not.toHaveBeenCalled();

    // Y no quedó escrito que se envió.
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("CORE_SYNC_MODE=real ya no significa nada: con la fila apagada, 501", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");

    vi.stubEnv("CORE_SYNC_MODE", "real");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    } as never);

    const update = montarLecturaDelCaso(db, DEFAULT_CASE_ROW, [
      { enabled: false, webhook_url: "https://core.example.com/hook", signing_secret_enc: "x.y.z" },
    ]);

    const { POST } = await import("@/app/api/cases/[id]/sync-to-core/route");
    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));

    expect(response.status).toBe(501);
    expect(update).not.toHaveBeenCalled();
    expect(real.syncCase).not.toHaveBeenCalled();
  });

  /*
   * La 0036 se aplica a mano y el código puede llegar antes. Sin la tabla, el
   * lote entero falla: es lo mismo que no tener fila, no un 500.
   */
  it.each([
    ["42P01 directo", Object.assign(new Error("relation does not exist"), { code: "42P01" })],
    ["42703 en cause", Object.assign(new Error("query failed"), { cause: { code: "42703" } })],
  ])("sin la 0036 (%s): 501 sin escribir", async (_nombre, falla) => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");
    const { writeAuditLog } = await import("@/lib/audit/log");

    vi.stubEnv("CORE_SYNC_MODE", "");
    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    } as never);
    const update = montarLecturaDelCaso(db, DEFAULT_CASE_ROW, falla);

    const { POST } = await import("@/app/api/cases/[id]/sync-to-core/route");
    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));

    expect(response.status).toBe(501);
    expect(update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("otro error de la base no se disfraza de 501", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");

    vi.stubEnv("CORE_SYNC_MODE", "");
    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    } as never);
    montarLecturaDelCaso(db, DEFAULT_CASE_ROW, Object.assign(new Error("boom"), { code: "57P01" }));

    const { POST } = await import("@/app/api/cases/[id]/sync-to-core/route");
    await expect(POST(makeRequest(), makeContext(VALID_CASE_ID))).rejects.toThrow("boom");
  });

  it("con el mock no se lee la config: dos lecturas, no tres", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    } as never);
    montarLecturaDelCaso(db);

    const { POST } = await import("@/app/api/cases/[id]/sync-to-core/route");
    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));

    expect(response.status).toBe(200);
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(real.syncCase).not.toHaveBeenCalled();
  });

  describe("con el webhook real de la aseguradora", () => {
    const WEBHOOK = "https://core.example.com/hook";

    async function filaActiva() {
      const { cifrar } = await import("@/lib/security/cifrado");
      return { enabled: true, webhook_url: WEBHOOK, signing_secret_enc: cifrar("test-signing-secret") };
    }

    beforeEach(() => {
      vi.stubEnv("CORE_SYNC_MODE", "");
      vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-encryption-key");
      real.configs.length = 0;
    });

    async function enviar(caseRow: unknown, config: unknown[], body: unknown = {}) {
      const { requireRole } = await import("@/lib/auth/require-role");
      const { db } = await import("@/lib/db");
      vi.mocked(requireRole).mockResolvedValue({
        user: { id: "user-1" },
        userRow: DEFAULT_USER_ROW,
      } as never);
      // `real` es la columna `esCasoReal`: por defecto, un caso de una persona.
      const update = montarLecturaDelCaso(db, { real: true, ...(caseRow as object) }, config);
      const { POST } = await import("@/app/api/cases/[id]/sync-to-core/route");
      const response = await POST(makeRequest(body), makeContext(VALID_CASE_ID));
      const set = update.mock.results[0]?.value.set as ReturnType<typeof vi.fn> | undefined;
      const where = set?.mock.results[0]?.value.where as ReturnType<typeof vi.fn> | undefined;
      return { response, body: await response.json(), update, set, where, seleccion: vi.mocked(db.select).mock.calls[0]?.[0] as Record<string, SQL> };
    }

    const dialecto = new PgDialect();

    it.each([
      ["el id que devolvió el Core", "CRM-778"],
      ["null si el Core no devolvió id", null],
    ])("2xx: enviado_a_core con %s, nunca uno inventado", async (_nombre, externalId) => {
      const { writeAuditLog } = await import("@/lib/audit/log");
      real.syncCase.mockResolvedValueOnce({ ok: true, externalId });

      const { response, body, set, seleccion } = await enviar(
        { ...DEFAULT_CASE_ROW, updated_at: "2026-09-28T12:00:00.123456Z" },
        [await filaActiva()]
      );

      expect(response.status).toBe(200);
      expect(body).toEqual({ synced: true, externalId });
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "enviado_a_core", core_external_id: externalId })
      );
      expect(JSON.stringify(set?.mock.calls)).not.toContain("CORE-");
      expect(writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: "core.sync_success",
          payload: expect.objectContaining({ core_external_id: externalId }),
        })
      );
      // El secreto le llega descifrado al cliente, y el payload lleva updatedAt.
      expect(real.configs).toEqual([{ url: WEBHOOK, secreto: "test-signing-secret" }]);
      expect(real.syncCase).toHaveBeenCalledWith(
        expect.objectContaining({ caseId: VALID_CASE_ID, updatedAt: "2026-09-28T12:00:00.123456Z" })
      );
      // updatedAt sale en ISO de la base, como en /api/v1, no en el texto de
      // Postgres («2026-09-28 12:00:00.123+00»): viaja también en X-ClaimMix-Event-Id.
      const { columnasDelCaso } = await import("@/server/core-sync/lectura");
      const leido = dialecto.sqlToQuery(seleccion.updated_at).sql;
      expect(leido).toBe(dialecto.sqlToQuery(columnasDelCaso.updated_at).sql);
      expect(leido).toContain("to_char");
    });

    it("un caso simulado o de prueba no se manda: 501 sin llamar al cliente ni escribir", async () => {
      const { writeAuditLog } = await import("@/lib/audit/log");

      const { response, body, update, seleccion } = await enviar(
        { ...DEFAULT_CASE_ROW, real: false },
        [await filaActiva()]
      );

      expect(response.status).toBe(501);
      expect(body.error.message).toMatch(/simulados o de prueba/);
      expect(real.syncCase).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      // El mismo criterio que /api/v1.
      const { esCasoReal } = await import("@/server/core-sync/lectura");
      expect(dialecto.sqlToQuery(seleccion.real).sql).toBe(dialecto.sqlToQuery(esCasoReal).sql);
    });

    it("el 2xx gana aunque otro envío haya dejado el caso en error_core", async () => {
      real.syncCase.mockResolvedValueOnce({ ok: true, externalId: "CRM-780" });

      const { where } = await enviar(DEFAULT_CASE_ROW, [await filaActiva()]);

      const { params } = dialecto.sqlToQuery(where?.mock.calls[0]?.[0]);
      expect(params).toEqual(expect.arrayContaining(["listo_para_core", "error_core"]));
    });

    it("el fallo sólo se escribe sobre el estado que se leyó", async () => {
      real.syncCase.mockResolvedValueOnce({ ok: false, motivo: "timeout" });

      const { where } = await enviar(DEFAULT_CASE_ROW, [await filaActiva()]);

      const { params } = dialecto.sqlToQuery(where?.mock.calls[0]?.[0]);
      expect(params).toContain("listo_para_core");
      expect(params).not.toContain("error_core");
    });

    it("falla: error_core con el motivo, en el caso, la respuesta y la auditoría", async () => {
      const { writeAuditLog } = await import("@/lib/audit/log");
      real.syncCase.mockResolvedValueOnce({ ok: false, motivo: "http_502" });

      const { response, body, set } = await enviar(DEFAULT_CASE_ROW, [await filaActiva()]);

      expect(response.status).toBe(200);
      expect(body).toEqual({ synced: false, errorMessage: "http_502" });
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error_core", core_error_message: "http_502" })
      );
      expect(writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: "core.sync_failed",
          payload: expect.objectContaining({ error_code: "CORE_SYNC_FAILED", motivo: "http_502" }),
        })
      );
    });

    it("force desde error_core reintenta con el cliente real", async () => {
      real.syncCase.mockResolvedValueOnce({ ok: true, externalId: "CRM-779" });

      const { response, body, set } = await enviar(
        { ...DEFAULT_CASE_ROW, status: "error_core" },
        [await filaActiva()],
        { force: true }
      );

      expect(response.status).toBe(200);
      expect(body.synced).toBe(true);
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "enviado_a_core" }));
    });

    it("un secreto que no se descifra es 501 sin escribir", async () => {
      const { response, update } = await enviar(DEFAULT_CASE_ROW, [
        { enabled: true, webhook_url: WEBHOOK, signing_secret_enc: "no.es.un-sobre" },
      ]);

      expect(response.status).toBe(501);
      expect(update).not.toHaveBeenCalled();
      expect(real.syncCase).not.toHaveBeenCalled();
    });

    it("activa pero sin URL es 501 sin escribir", async () => {
      const fila = { ...(await filaActiva()), webhook_url: null };
      const { response, update } = await enviar(DEFAULT_CASE_ROW, [fila]);

      expect(response.status).toBe(501);
      expect(update).not.toHaveBeenCalled();
    });
  });

  /*
   * E25: la escritura de estado ya no es incondicional.
   *
   * Entre leer el caso y escribir el resultado del envío puede pasar cualquier
   * cosa: otra pestaña, un reintento, el barrido de fondo. Si la fila ya no
   * está en el estado que se leyó, `.returning()` vuelve vacío y hay que
   * avisarlo — nunca pisar un estado que ya cambió.
   */
  it("E25: éxito con la fila movida — 409 y CORE_SYNC_SUCCESS con status_not_applied", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");
    const { writeAuditLog } = await import("@/lib/audit/log");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    } as never);

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([DEFAULT_CASE_ROW]),
            }),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(DEFAULT_EXTRACTED_FIELDS),
        }),
      } as any;
    });

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("FSM_INVALID_TRANSITION");

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "core.sync_success",
        target_id: VALID_CASE_ID,
        payload: expect.objectContaining({ status_not_applied: true }),
      })
    );
  });

  it("E25: fallo con la fila movida — 200 synced:false y CORE_SYNC_FAILED con status_not_applied", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");
    const { writeAuditLog } = await import("@/lib/audit/log");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    } as never);

    const failingCaseRow = {
      id: FAILING_CASE_ID,
      status: "listo_para_core",
      tenant_id: "tenant-1",
      claim_type: "choque",
      severity: "medium",
      policy_number: null,
      policyholder_name: null,
      customer_id: null,
      policy_id: null,
    };

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([failingCaseRow]),
            }),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(DEFAULT_EXTRACTED_FIELDS),
        }),
      } as any;
    });

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(FAILING_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.synced).toBe(false);

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "core.sync_failed",
        target_id: FAILING_CASE_ID,
        payload: expect.objectContaining({ status_not_applied: true }),
      })
    );
  });

  it("E25: force con el caso ya enviado al Core — 409, no llama al cliente del Core", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");
    const coreSyncClient = await import("@/server/core-sync/client");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    } as never);

    const yaEnviadoCaseRow = { ...DEFAULT_CASE_ROW, status: "enviado_a_core" };

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([yaEnviadoCaseRow]),
        }),
      }),
    } as any);

    const espiaCliente = vi.spyOn(coreSyncClient, "getCoreSyncClient");

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest({ force: true }), makeContext(VALID_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("FSM_INVALID_TRANSITION");
    expect(espiaCliente).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each(["cerrado", "en_liquidacion", "pagado", "rechazado", "enviado_a_core", "listo"])(
    "force desde %s — 409, no llama al cliente del Core",
    async (status) => {
      const { requireRole } = await import("@/lib/auth/require-role");
      const { db } = await import("@/lib/db");
      const coreSyncClient = await import("@/server/core-sync/client");

      vi.mocked(requireRole).mockResolvedValue({
        user: { id: "user-1" },
        userRow: DEFAULT_USER_ROW,
      } as never);
      const update = montarLecturaDelCaso(db, { ...DEFAULT_CASE_ROW, status });
      const espiaCliente = vi.spyOn(coreSyncClient, "getCoreSyncClient");

      const { POST } = await import("@/app/api/cases/[id]/sync-to-core/route");
      const response = await POST(makeRequest({ force: true }), makeContext(VALID_CASE_ID));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error.code).toBe("FSM_INVALID_TRANSITION");
      expect(espiaCliente).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    }
  );

  it.each(["error_core", "listo_para_core"])("force desde %s sigue enviando", async (status) => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    } as never);
    const update = montarLecturaDelCaso(db, { ...DEFAULT_CASE_ROW, status });

    const { POST } = await import("@/app/api/cases/[id]/sync-to-core/route");
    const response = await POST(makeRequest({ force: true }), makeContext(VALID_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.synced).toBe(true);
    expect(update).toHaveBeenCalled();
  });
});
