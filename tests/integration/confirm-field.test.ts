/**
 * Integration-style unit tests for PATCH /api/cases/:id/confirm-field.
 *
 * These tests mock @/lib/db and @/lib/auth/require-role to test the route
 * handler logic directly without spinning up a server or live DB.
 *
 * AC14: Memory only updated via confirm-field (updateMemoryFromConfirmation called).
 * AC21: Audit log FIELD_CONFIRMED with redacted values.
 * AC16: FSM re-evaluated after confirmation.
 * AC19: 404 for wrong-tenant case (IDOR defense).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks must be hoisted before any imports that use them ────────────────────

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

vi.mock("@/lib/db", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { db: mockDb };
});

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
  ALL_ROLES: ["owner", "admin", "specialist", "analyst", "viewer"],
}));

vi.mock("@/server/memory/update", () => ({
  updateMemoryFromConfirmation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    FIELD_CONFIRMED: "claim.field_confirmed",
    CASE_STATUS_CHANGED: "case.status_changed",
    MEMORY_APPLIED: "memory.applied",
  },
}));

vi.mock("@/server/cases/gap-analyzer", () => ({
  analyzeEmailClaimGaps: vi.fn().mockResolvedValue({
    missingRequiredFields: [],
    fieldsNeedingConfirmation: [],
    isComplete: true,
    status: "listo_para_core",
  }),
}));

// Mock rate-limit to always allow.
vi.mock("@/lib/rate-limit/index", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit/index")>(
    "@/lib/rate-limit/index"
  );
  return {
    ...actual,
    rateLimit: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: 0,
      retryAfterSeconds: 0,
    }),
  };
});

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/require-role";
import { updateMemoryFromConfirmation } from "@/server/memory/update";
import { writeAuditLog } from "@/lib/audit/log";
import { PATCH } from "@/app/api/cases/[id]/confirm-field/route";

// ── Constants ─────────────────────────────────────────────────────────────────

const CASE_ID = "123e4567-e89b-12d3-a456-426614174000";
const TENANT_ID = "tenant-1";
const USER_ID = "user-1";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown, caseId = CASE_ID) {
  const url = `http://localhost/api/cases/${caseId}/confirm-field`;
  return new Request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

function makeContext(caseId = CASE_ID) {
  return { params: Promise.resolve({ id: caseId }) };
}

/**
 * Set up requireRole to return a valid analyst session.
 */
function setupAuth(role: string = "analyst") {
  vi.mocked(requireRole).mockResolvedValue({
    db: db as any,
    user: { id: USER_ID, email: "test@example.com" },
    userRow: { id: USER_ID, tenant_id: TENANT_ID, role: role as any },
  });
}

/**
 * Set up requireRole to throw (unauthenticated).
 */
function setupNoAuth() {
  vi.mocked(requireRole).mockRejectedValue(new Error("MISSING_SESSION"));
}

/**
 * Build a chainable select mock that resolves to the given rows.
 * Handles both .limit() and bare await (thennable).
 */
function selectChain(rows: unknown[]) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  return chain;
}

/**
 * Build a chainable update mock that resolves successfully.
 */
function updateChain() {
  const chain: any = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    then: (resolve: (v: unknown) => void) => resolve([]),
  };
  return chain;
}

/**
 * Build a chainable insert mock that resolves successfully.
 */
function insertChain() {
  const chain: any = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue([]),
    then: (resolve: (v: unknown) => void) => resolve([]),
  };
  return chain;
}

/**
 * Default DB mock setup for a successful confirm action.
 *
 * db.select calls (in order):
 *  1. case lookup -> returns caseRow
 *  2. confirmation row -> returns confirmationRow
 *  3. getSenderEmail (raw_messages) -> returns senderRow
 *  4. reEvaluateStatus: extracted_fields -> returns []
 *
 * db.update calls (in order):
 *  1. update claimFieldConfirmations status
 *  2. satisfy missing_docs
 *  3. update case status (if transition)
 *
 * db.insert calls (in order):
 *  1. upsert extracted_fields
 */
function setupDbForConfirm(opts: {
  caseRow?: unknown;
  confirmationRow?: unknown;
  senderRow?: unknown;
  extractedFields?: unknown[];
} = {}) {
  const {
    caseRow = { id: CASE_ID, status: "confirmacion_pendiente", tenant_id: TENANT_ID },
    confirmationRow = {
      id: "conf-1",
      proposed_value: "Juan Pérez",
      conflict_with_value: null,
      status: "pending",
    },
    senderRow = { from_addr: "sender@example.com" },
    extractedFields = [],
  } = opts;

  vi.mocked(db.select)
    .mockReturnValueOnce(selectChain(caseRow ? [caseRow] : []))    // case lookup
    .mockReturnValueOnce(selectChain(confirmationRow ? [confirmationRow] : [])) // confirmation
    .mockReturnValueOnce(selectChain(senderRow ? [senderRow] : [])) // getSenderEmail
    .mockReturnValueOnce(selectChain(extractedFields));              // reEvaluateStatus

  vi.mocked(db.update).mockReturnValue(updateChain() as any);
  vi.mocked(db.insert).mockReturnValue(insertChain() as any);
}

/**
 * Setup for reject action (no insert, different update path).
 */
function setupDbForReject(opts: {
  caseRow?: unknown;
  confirmationRow?: unknown;
} = {}) {
  const {
    caseRow = { id: CASE_ID, status: "confirmacion_pendiente", tenant_id: TENANT_ID },
    confirmationRow = {
      id: "conf-1",
      proposed_value: "Juan Pérez",
      conflict_with_value: null,
      status: "pending",
    },
  } = opts;

  vi.mocked(db.select)
    .mockReturnValueOnce(selectChain(caseRow ? [caseRow] : []))
    .mockReturnValueOnce(selectChain(confirmationRow ? [confirmationRow] : []));

  vi.mocked(db.update).mockReturnValue(updateChain() as any);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/cases/:id/confirm-field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset db mock queues so mockReturnValueOnce calls don't bleed between tests.
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.insert).mockReset();
    // Re-apply stable implementations cleared by mockReset.
    vi.mocked(updateMemoryFromConfirmation).mockResolvedValue(undefined);
    vi.mocked(writeAuditLog).mockResolvedValue(undefined);
  });

  it("confirm action: returns 200 with updated status", async () => {
    setupAuth();
    setupDbForConfirm();

    const req = makeRequest({
      field_key: "full_name",
      value: "Juan Pérez",
      action: "confirm",
    });

    const response = await PATCH(req, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      case_id: CASE_ID,
      field_key: "full_name",
    });
  });

  it("AC14: calls updateMemoryFromConfirmation after confirm action", async () => {
    setupAuth();
    setupDbForConfirm();

    await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(updateMemoryFromConfirmation).toHaveBeenCalledWith(
      TENANT_ID,
      "full_name",
      "Juan Pérez",
      "sender@example.com",
      CASE_ID,
      USER_ID,
      "Juan Pérez" // old proposed_value from confirmationRow
    );
  });

  it("AC21: writes FIELD_CONFIRMED audit log", async () => {
    setupAuth();
    setupDbForConfirm();

    await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "claim.field_confirmed",
        target_id: CASE_ID,
      })
    );
  });

  it("reject action: returns 200 with rejected status", async () => {
    setupAuth();
    setupDbForReject();

    const req = makeRequest({
      field_key: "full_name",
      value: null,
      action: "reject",
    });

    const response = await PATCH(req, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.field_key).toBe("full_name");
    expect(body.claim_memory_updated).toBe(false);
  });

  it("reject action: logs FIELD_CONFIRMED audit event", async () => {
    setupAuth();
    setupDbForReject();

    await PATCH(
      makeRequest({ field_key: "full_name", value: null, action: "reject" }),
      makeContext()
    );

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "claim.field_confirmed",
        payload: expect.objectContaining({ action: "rejected" }),
      })
    );
  });

  it("returns 401 when unauthenticated", async () => {
    setupNoAuth();

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(401);
  });

  it("AC19: returns 404 when case belongs to different tenant (IDOR defense)", async () => {
    setupAuth();

    // Case lookup returns empty array (no row for this tenant).
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([]))    // case lookup -> not found
      .mockReturnValueOnce(selectChain([]));   // confirmation (may or may not be called)

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 when request body is invalid", async () => {
    setupAuth();

    // DB select for case lookup - but validation happens before case lookup
    // so we still need the auth mock but not necessarily the db mock.
    // Still set up db just in case the route fetches the case first.
    vi.mocked(db.select).mockReturnValue(selectChain([]) as any);

    const response = await PATCH(
      makeRequest({ field_key: "", value: "test", action: "invalid_action" }),
      makeContext()
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("correct action: returns 200 with corrected value", async () => {
    setupAuth();
    setupDbForConfirm();

    const req = makeRequest({
      field_key: "full_name",
      value: "María García",
      action: "correct",
    });

    const response = await PATCH(req, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      case_id: CASE_ID,
      field_key: "full_name",
    });
  });

  it("confirm without existing confirmation row still succeeds", async () => {
    setupAuth();
    // Override: no confirmation row
    setupDbForConfirm({ confirmationRow: null });

    const response = await PATCH(
      makeRequest({ field_key: "policy_number", value: "POL-999", action: "confirm" }),
      makeContext()
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.field_key).toBe("policy_number");
  });
});
