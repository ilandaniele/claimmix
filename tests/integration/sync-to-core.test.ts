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
 * These tests mock the DB clients and test the route handler logic directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    CORE_SYNC_SUCCESS: "core.sync_success",
    CORE_SYNC_FAILED: "core.sync_failed",
  },
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

function makeChain(data: unknown, error: unknown = null) {
  const final = Promise.resolve({ data, error });
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    single: () => final,
    maybeSingle: () => final,
    update: () => chain,
    upsert: () => Promise.resolve({ error: null }),
    order: () => chain,
    limit: () => chain,
    range: () => chain,
    in: () => chain,
    is: () => final,
  };
  return chain;
}

function buildUserSupabase(opts: {
  user?: { id: string } | null;
  userRow?: { id: string; tenant_id: string; role: string } | null;
  caseRow?: Record<string, unknown> | null;
}) {
  const {
    user = { id: "user-1" },
    userRow = { id: "user-1", tenant_id: "tenant-1", role: "admin" },
    caseRow = {
      id: VALID_CASE_ID,
      status: "listo_para_core",
      tenant_id: "tenant-1",
      claim_type: "choque",
      severity: "low",
      policy_number: "POL-2024-001",
      policyholder_name: "Juan Pérez",
      customer_id: null,
      policy_id: null,
    },
  } = opts;

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "users") return makeChain(userRow);
      if (table === "cases") return makeChain(caseRow);
      return makeChain(null);
    }),
  };
}

function buildServiceSupabase(opts: {
  extractedFields?: Array<{ field_key: string; field_value: string }>;
  updateResult?: { error: unknown };
} = {}) {
  const {
    extractedFields = [
      { field_key: "accident_date", field_value: "2024-01-15" },
      { field_key: "accident_description", field_value: "Choque en Av. Cabildo" },
    ],
    updateResult = { error: null },
  } = opts;

  const chain: any = {
    select: () => chain,
    eq: () => chain,
    single: () => Promise.resolve({ data: null, error: null }),
    update: () => ({
      eq: () => Promise.resolve(updateResult),
    }),
    order: () => chain,
    limit: () => chain,
    range: () => chain,
  };

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "extracted_fields") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: extractedFields, error: null }),
          }),
        };
      }
      return {
        ...chain,
        update: () => ({
          eq: () => Promise.resolve(updateResult),
        }),
      };
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/cases/:id/sync-to-core", () => {
  let createServerClientMock: ReturnType<typeof vi.fn>;
  let createServiceClientMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const { createServerClient } = await import("@/lib/supabase/server");
    const { createServiceClient } = await import("@/lib/supabase/service");
    createServerClientMock = createServerClient as ReturnType<typeof vi.fn>;
    createServiceClientMock = createServiceClient as ReturnType<typeof vi.fn>;
  });

  it("listo_para_core → enviado_a_core (mock success)", async () => {
    createServerClientMock.mockResolvedValue(buildUserSupabase({}));
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

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
    createServerClientMock.mockResolvedValue(buildUserSupabase({}));
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

    const { writeAuditLog } = await import("@/lib/audit/log");
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
    createServerClientMock.mockResolvedValue(
      buildUserSupabase({
        caseRow: {
          id: FAILING_CASE_ID,
          status: "listo_para_core",
          tenant_id: "tenant-1",
          claim_type: "choque",
          severity: "medium",
          policy_number: null,
          policyholder_name: null,
          customer_id: null,
          policy_id: null,
        },
      })
    );
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

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
    createServerClientMock.mockResolvedValue(
      buildUserSupabase({
        caseRow: {
          id: FAILING_CASE_ID,
          status: "listo_para_core",
          tenant_id: "tenant-1",
          claim_type: "choque",
          severity: "medium",
          policy_number: null,
          policyholder_name: null,
          customer_id: null,
          policy_id: null,
        },
      })
    );
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

    const { writeAuditLog } = await import("@/lib/audit/log");
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

  it("wrong status → 400 FSM_INVALID_TRANSITION", async () => {
    createServerClientMock.mockResolvedValue(
      buildUserSupabase({
        caseRow: {
          id: VALID_CASE_ID,
          status: "recibido", // wrong status — must be listo_para_core
          tenant_id: "tenant-1",
          claim_type: "choque",
          severity: null,
          policy_number: null,
          policyholder_name: null,
          customer_id: null,
          policy_id: null,
        },
      })
    );
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("FSM_INVALID_TRANSITION");
  });

  it("wrong role → 403 FORBIDDEN_ROLE", async () => {
    createServerClientMock.mockResolvedValue(
      buildUserSupabase({
        userRow: { id: "user-2", tenant_id: "tenant-1", role: "analyst" }, // analyst not allowed
      })
    );

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
  });

  it("AC19: returns 404 for non-existent / wrong-tenant case", async () => {
    createServerClientMock.mockResolvedValue(
      buildUserSupabase({ caseRow: null })
    );

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 401 when unauthenticated", async () => {
    createServerClientMock.mockResolvedValue(
      buildUserSupabase({ user: null, userRow: null })
    );

    const { POST } = await import(
      "@/app/api/cases/[id]/sync-to-core/route"
    );

    const response = await POST(makeRequest(), makeContext(VALID_CASE_ID));

    expect(response.status).toBe(401);
  });
});
