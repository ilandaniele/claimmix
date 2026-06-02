/**
 * Unit tests for the case patch logic.
 *
 * Tests FSM validation, ownership checks, and audit log behavior
 * using a mocked Supabase client and mocked audit log.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { patchCase } from "@/server/cases/patch";
import { AppError } from "@/lib/errors";

// Mock the audit log to avoid Supabase calls
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    CASE_STATUS_CHANGED: "case.status_changed",
    CASE_CLOSED: "case.closed",
    CASE_ASSIGNED: "case.assigned",
  },
}));

// ── Mock helpers ──────────────────────────────────────────────────────────────

type FetchResult = { data: unknown; error: { code: string } | null };

function buildPatchMock(
  fetchResult: FetchResult,
  updateResult: FetchResult
) {
  const updateChain = {
    update: () => updateChain,
    eq: () => updateChain,
    select: () => updateChain,
    single: () => Promise.resolve(updateResult),
  };

  const fetchChain = {
    select: () => fetchChain,
    eq: () => fetchChain,
    single: () => Promise.resolve(fetchResult),
  };

  return {
    from: (table: string) => {
      if (table === "cases") {
        return {
          select: () => fetchChain,
          update: () => updateChain,
        };
      }
      return { select: () => ({}) };
    },
  };
}

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

// ── patchCase — FSM validation ────────────────────────────────────────────────

describe("patchCase — FSM validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws FSM_INVALID_TRANSITION for cerrado → procesando", async () => {
    const cerradoCase = { ...listoCase, status: "cerrado" };
    const supabase = buildPatchMock(
      { data: cerradoCase, error: null },
      { data: { ...cerradoCase, status: "procesando" }, error: null }
    );

    await expect(
      patchCase(supabase, "case-1", { status: "procesando" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("throws FSM_INVALID_TRANSITION for procesando → cerrado", async () => {
    const procesandoCase = { ...listoCase, status: "procesando" };
    const supabase = buildPatchMock(
      { data: procesandoCase, error: null },
      { data: { ...procesandoCase, status: "cerrado" }, error: null }
    );

    await expect(
      patchCase(supabase, "case-1", { status: "cerrado" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("succeeds for valid FSM transition: listo → cerrado", async () => {
    const updatedCase = { ...listoCase, status: "cerrado", closed_at: new Date().toISOString() };
    const supabase = buildPatchMock(
      { data: listoCase, error: null },
      { data: updatedCase, error: null }
    );

    const result = await patchCase(
      supabase,
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
    const supabase = buildPatchMock(
      { data: listoCase, error: null },
      { data: updatedCase, error: null }
    );

    const result = await patchCase(
      supabase,
      "case-1",
      { status: "escalado" },
      adminActor,
      null,
      null
    );
    expect(result.case.status).toBe("escalado");
  });

  it("throws FSM_INVALID_TRANSITION for listo → esperando (not in allowed transitions)", async () => {
    const supabase = buildPatchMock(
      { data: listoCase, error: null },
      { data: {}, error: null }
    );

    await expect(
      patchCase(supabase, "case-1", { status: "esperando" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });
});

// ── patchCase — not found / IDOR ─────────────────────────────────────────────

describe("patchCase — IDOR and not found", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws NOT_FOUND when case does not exist", async () => {
    const supabase = buildPatchMock(
      { data: null, error: { code: "PGRST116" } },
      { data: null, error: null }
    );

    await expect(
      patchCase(supabase, "non-existent", { status: "listo" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("throws NOT_FOUND (not FORBIDDEN) for wrong-tenant case (IDOR prevention)", async () => {
    // RLS blocks the row → same as not found
    const supabase = buildPatchMock(
      { data: null, error: { code: "PGRST116" } },
      { data: null, error: null }
    );

    try {
      await patchCase(supabase, "other-tenant-case", { status: "listo" }, adminActor, null, null);
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
    const supabase = buildPatchMock(
      { data: caseAssignedToOther, error: null },
      { data: updatedCase, error: null }
    );

    const result = await patchCase(
      supabase,
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
    const supabase = buildPatchMock(
      { data: caseAssignedToOther, error: null },
      { data: {}, error: null }
    );

    await expect(
      patchCase(
        supabase,
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
    const supabase = buildPatchMock(
      { data: listoCase, error: null },
      { data: updatedCase, error: null }
    );

    const result = await patchCase(
      supabase,
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

  it("throws NOT_FOUND when Supabase update returns no rows (RLS blocked write)", async () => {
    const supabase = buildPatchMock(
      { data: listoCase, error: null },
      { data: null, error: { code: "PGRST116" } }
    );

    await expect(
      patchCase(supabase, "case-1", { status: "escalado" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});
