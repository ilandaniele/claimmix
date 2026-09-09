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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

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

const DEFAULT_USER_ROW = { id: "user-1", tenant_id: "tenant-1", role: "admin" as const };

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

function buildDbMocks(opts: {
  caseRow?: Record<string, unknown> | null;
  extractedFields?: Array<{ field_key: string; field_value: string }>;
} = {}) {
  const {
    caseRow = DEFAULT_CASE_ROW,
    extractedFields = DEFAULT_EXTRACTED_FIELDS,
  } = opts;

  return {
    // db.select() returns different data based on call order
    select: vi.fn().mockImplementation(() => {
      let callCount = 0;
      const outerChain: any = {
        from: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First select: cases query
            return {
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(
                  caseRow ? [caseRow] : []
                ),
              }),
            };
          }
          // Second select: extracted_fields query
          return {
            where: vi.fn().mockResolvedValue(extractedFields),
          };
        }),
      };
      return outerChain;
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }),
    }),
  };
}

/**
 * Las dos lecturas que hace la ruta antes de llamar al cliente: el caso y sus
 * campos extraidos. Se usa un contador compartido, igual que los casos de mas
 * arriba: `buildDbMocks` arma la cadena de nuevo en cada llamada y su contador
 * vuelve a cero, asi que la segunda lectura nunca devuelve las filas.
 *
 * Devuelve el espia de `update` para poder afirmar que NO se llamo.
 */
function montarLecturaDelCaso(db: any) {
  let n = 0;
  db.select.mockImplementation(() => {
    n += 1;
    if (n === 1) {
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([DEFAULT_CASE_ROW]),
          }),
        }),
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
      where: vi.fn().mockResolvedValue({ rowCount: 1 }),
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
        where: vi.fn().mockResolvedValue({ rowCount: 1 }),
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
        where: vi.fn().mockResolvedValue({ rowCount: 1 }),
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
        where: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }),
    } as any);

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(FAILING_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.synced).toBe(false);
    expect(body.errorMessage).toBe("Core timeout");
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
        where: vi.fn().mockResolvedValue({ rowCount: 1 }),
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

  it("CORE_SYNC_MODE=real tampoco inventa: todavía no hay cliente real", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");

    vi.stubEnv("CORE_SYNC_MODE", "real");

    vi.mocked(requireRole).mockResolvedValue({
      user: { id: "user-1" },
      userRow: DEFAULT_USER_ROW,
    } as never);

    const update = montarLecturaDelCaso(db);

    const { POST } = await import("@/app/api/cases/[id]/sync-to-core/route");
    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));

    expect(response.status).toBe(501);
    expect(update).not.toHaveBeenCalled();
  });
});
