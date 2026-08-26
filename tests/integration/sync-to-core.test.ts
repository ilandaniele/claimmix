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

import { describe, it, expect, vi, beforeEach } from "vitest";

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/cases/:id/sync-to-core", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("listo_para_core → enviado_a_core (mock success)", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const { db } = await import("@/lib/db");

    vi.mocked(requireRole).mockResolvedValue({
      db: db as any,
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
      db: db as any,
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
      db: db as any,
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
      db: db as any,
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
      db: db as any,
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
      db: db as any,
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
});
