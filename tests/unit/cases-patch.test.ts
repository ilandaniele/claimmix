/**
 * Unit tests for the case patch logic.
 *
 * Tests FSM validation, ownership checks, and audit log behavior
 * using a mocked Drizzle db and mocked audit log.
 */

// vi.mock calls must be hoisted to module top level before any other imports
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

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    $count: vi.fn(),
  },
  tables: {},
}));

// Mock the audit log to avoid DB calls
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    CASE_STATUS_CHANGED: "case.status_changed",
    CASE_CLOSED: "case.closed",
    CASE_ASSIGNED: "case.assigned",
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { patchCase } from "@/server/cases/patch";
import { AppError } from "@/lib/errors";
import { db } from "@/lib/db";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const adminActor = {
  id: "user-admin-1",
  tenant_id: "tenant-1",
  full_name: "Carlos Medina",
  role: "admin" as const,
  created_at: "2024-01-01T00:00:00Z",
};

const analystActor = {
  id: "user-analyst-1",
  tenant_id: "tenant-1",
  full_name: "Lucía Ramallo",
  role: "analyst" as const,
  created_at: "2024-01-01T00:00:00Z",
};

const listoCase = {
  id: "case-1",
  tenant_id: "tenant-1",
  status: "listo",
  claim_type: "choque",
  assigned_to: "user-analyst-1",
  policy_number: "POL-2024-001",
  policyholder_name: "Juan García",
  confidence_min: 0.85,
  channel: "email_sim",
  created_at: "2024-01-15T00:00:00Z",
  updated_at: null,
  closed_at: null,
};

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Configure db.select and db.update mocks for a fetch+update cycle.
 *
 * fetchRows: rows returned by db.select().from().where().limit(1)
 * updatedRows: rows returned by db.update().set().where().returning()
 */
function setupPatchMocks(fetchRows: unknown[], updatedRows: unknown[]) {
  // db.select chain: .from().where().limit() → resolves to fetchRows
  const selectChain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(fetchRows),
  };
  vi.mocked(db.select).mockReturnValue(selectChain as any);

  // db.update chain: .set().where().returning() → resolves to updatedRows
  const returningFn = vi.fn().mockResolvedValue(updatedRows);
  const whereAfterSet = vi.fn().mockReturnValue({ returning: returningFn });
  const setChain: any = {
    set: vi.fn().mockReturnValue({ where: whereAfterSet }),
  };
  vi.mocked(db.update).mockReturnValue(setChain as any);
}

// ── patchCase — FSM validation ────────────────────────────────────────────────

describe("patchCase — FSM validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws FSM_INVALID_TRANSITION for cerrado → procesando", async () => {
    const cerradoCase = { ...listoCase, status: "cerrado" };
    setupPatchMocks([cerradoCase], [{ ...cerradoCase, status: "procesando" }]);

    await expect(
      patchCase("case-1", { status: "procesando" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("throws FSM_INVALID_TRANSITION for procesando → cerrado", async () => {
    const procesandoCase = { ...listoCase, status: "procesando" };
    setupPatchMocks([procesandoCase], [{ ...procesandoCase, status: "cerrado" }]);

    await expect(
      patchCase("case-1", { status: "cerrado" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("succeeds for valid FSM transition: listo → cerrado", async () => {
    const updatedCase = { ...listoCase, status: "cerrado", closed_at: new Date().toISOString() };
    setupPatchMocks([listoCase], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "cerrado", reason: "paid_out" },
      adminActor,
      null,
      null
    );
    expect(result.case.status).toBe("cerrado");
  });

  it("succeeds for valid FSM transition: listo → escalado", async () => {
    const updatedCase = { ...listoCase, status: "escalado" };
    setupPatchMocks([listoCase], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "escalado" },
      adminActor,
      null,
      null
    );
    expect(result.case.status).toBe("escalado");
  });

  it("throws FSM_INVALID_TRANSITION for listo → esperando (not in allowed transitions)", async () => {
    setupPatchMocks([listoCase], []);

    await expect(
      patchCase("case-1", { status: "esperando" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });
});

// ── patchCase — not found / IDOR ─────────────────────────────────────────────

describe("patchCase — IDOR and not found", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws NOT_FOUND when case does not exist", async () => {
    // db.select returns no rows → case not found
    setupPatchMocks([], []);

    await expect(
      patchCase("non-existent", { status: "listo" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("throws NOT_FOUND (not FORBIDDEN) for wrong-tenant case (IDOR prevention)", async () => {
    // Explicit tenant filter means wrong-tenant case returns zero rows
    setupPatchMocks([], []);

    try {
      await patchCase("other-tenant-case", { status: "listo" }, adminActor, null, null);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const appErr = e as AppError;
      // Must be NOT_FOUND — never FORBIDDEN_ROLE
      expect(appErr.code).toBe("NOT_FOUND");
      expect(appErr.status).toBe(404);
    }
  });
});

// ── patchCase — ownership check ───────────────────────────────────────────────

describe("patchCase — ownership check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows admin to patch any case in their tenant", async () => {
    const caseAssignedToOther = { ...listoCase, assigned_to: "other-analyst" };
    const updatedCase = { ...caseAssignedToOther, status: "escalado" };
    setupPatchMocks([caseAssignedToOther], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "escalado" },
      adminActor, // admin can patch any case
      null,
      null
    );
    expect(result.case.status).toBe("escalado");
  });

  it("throws NOT_FOUND when analyst patches a case not assigned to them", async () => {
    const caseAssignedToOther = { ...listoCase, assigned_to: "other-analyst-id" };
    setupPatchMocks([caseAssignedToOther], []);

    await expect(
      patchCase(
        "case-1",
        { status: "cerrado" },
        analystActor, // analyst does not own this case
        null,
        null
      )
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("allows analyst to patch a case assigned to them", async () => {
    // analystActor.id === listoCase.assigned_to
    const updatedCase = { ...listoCase, status: "cerrado" };
    setupPatchMocks([listoCase], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "cerrado" },
      analystActor,
      null,
      null
    );
    expect(result.case.status).toBe("cerrado");
  });
});

// ── patchCase — update failure ────────────────────────────────────────────────

describe("patchCase — update failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws NOT_FOUND when DB update returns no rows (RLS-equivalent: tenant filter blocked write)", async () => {
    // Select finds the case, but update returns no rows (wrong tenant on write)
    setupPatchMocks([listoCase], []);

    await expect(
      patchCase("case-1", { status: "escalado" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});
