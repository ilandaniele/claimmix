/**
 * Integration-style unit tests for PATCH /api/cases/:id/confirm-field.
 *
 * These tests mock the Supabase clients and test the route handler logic
 * directly without spinning up a server.
 *
 * AC14: Memory only updated via confirm-field (updateMemoryFromConfirmation called).
 * AC21: Audit log FIELD_CONFIRMED with redacted values.
 * AC16: FSM re-evaluated after confirmation.
 *
 * Note: True integration tests (INTEGRATION_ENABLED=true) require a live DB.
 * These tests exercise the route handler logic with mocked DB responses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown, caseId = "123e4567-e89b-12d3-a456-426614174000") {
  const url = `http://localhost/api/cases/${caseId}/confirm-field`;
  return new Request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

function makeContext(caseId = "123e4567-e89b-12d3-a456-426614174000") {
  return { params: Promise.resolve({ id: caseId }) };
}

function buildUserSupabase(opts: {
  user?: { id: string } | null;
  userRow?: { id: string; tenant_id: string; role: string } | null;
  caseRow?: Record<string, unknown> | null;
  confirmationRow?: Record<string, unknown> | null;
  rateLimitAllowed?: boolean;
}) {
  const {
    user = { id: "user-1" },
    userRow = { id: "user-1", tenant_id: "tenant-1", role: "analyst" },
    caseRow = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      status: "confirmacion_pendiente",
      tenant_id: "tenant-1",
      email_thread_id: "thread-1",
    },
    confirmationRow = {
      id: "conf-1",
      proposed_value: "Juan Pérez",
      conflict_with_value: null,
      status: "pending",
    },
    rateLimitAllowed = true,
  } = opts;

  // Build mock that tracks what table/op is being called
  const chainFor = (data: unknown, error: unknown = null) => {
    const final = Promise.resolve({ data, error });
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      single: () => final,
      maybeSingle: () => final,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      is: () => final,
      ilike: () => chain,
      update: () => chain,
      upsert: () => final,
      range: () => chain,
    };
    return chain;
  };

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "users") return chainFor(userRow);
      if (table === "cases") return chainFor(caseRow);
      if (table === "claim_field_confirmations") return chainFor(confirmationRow);
      return chainFor(null);
    }),
  };
}

function buildServiceSupabase(opts: {
  rawMsgRow?: Record<string, unknown> | null;
  extractedFields?: Array<{ field_key: string; field_value: string; confidence: number; source: string }>;
} = {}) {
  const {
    rawMsgRow = { from_addr: "sender@example.com" },
    extractedFields = [],
  } = opts;

  const chainFor = (data: unknown, error: unknown = null) => {
    const final = Promise.resolve({ data, error });
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      single: () => final,
      maybeSingle: () => final,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      is: () => final,
      ilike: () => chain,
      update: () => chain,
      upsert: () => Promise.resolve({ error: null }),
      range: () => chain,
    };
    return chain;
  };

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "raw_messages") return chainFor(rawMsgRow);
      if (table === "extracted_fields") return chainFor(extractedFields);
      return chainFor(null);
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/cases/:id/confirm-field", () => {
  let createServerClientMock: ReturnType<typeof vi.fn>;
  let createServiceClientMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { createServerClient } = await import("@/lib/supabase/server");
    const { createServiceClient } = await import("@/lib/supabase/service");
    createServerClientMock = createServerClient as ReturnType<typeof vi.fn>;
    createServiceClientMock = createServiceClient as ReturnType<typeof vi.fn>;
  });

  it("confirm action: returns 200 with updated status", async () => {
    createServerClientMock.mockResolvedValue(buildUserSupabase({}));
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

    const { PATCH } = await import(
      "@/app/api/cases/[id]/confirm-field/route"
    );

    const req = makeRequest({
      field_key: "full_name",
      value: "Juan Pérez",
      action: "confirm",
    });

    const response = await PATCH(req, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      case_id: "123e4567-e89b-12d3-a456-426614174000",
      field_key: "full_name",
    });
  });

  it("AC14: calls updateMemoryFromConfirmation after confirm action", async () => {
    createServerClientMock.mockResolvedValue(buildUserSupabase({}));
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

    const { updateMemoryFromConfirmation } = await import(
      "@/server/memory/update"
    );

    const { PATCH } = await import(
      "@/app/api/cases/[id]/confirm-field/route"
    );

    await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(updateMemoryFromConfirmation).toHaveBeenCalledWith(
      expect.anything(), // supabase
      "tenant-1",
      "full_name",
      "Juan Pérez",
      "sender@example.com",
      "123e4567-e89b-12d3-a456-426614174000",
      "user-1",
      "Juan Pérez" // old proposed_value from confirmationRow
    );
  });

  it("AC21: writes FIELD_CONFIRMED audit log", async () => {
    createServerClientMock.mockResolvedValue(buildUserSupabase({}));
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

    const { writeAuditLog } = await import("@/lib/audit/log");

    const { PATCH } = await import(
      "@/app/api/cases/[id]/confirm-field/route"
    );

    await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "claim.field_confirmed",
        target_id: "123e4567-e89b-12d3-a456-426614174000",
      })
    );
  });

  it("reject action: returns 200 with rejected status", async () => {
    createServerClientMock.mockResolvedValue(buildUserSupabase({}));
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

    const { PATCH } = await import(
      "@/app/api/cases/[id]/confirm-field/route"
    );

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
    createServerClientMock.mockResolvedValue(buildUserSupabase({}));
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

    const { writeAuditLog } = await import("@/lib/audit/log");

    const { PATCH } = await import(
      "@/app/api/cases/[id]/confirm-field/route"
    );

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
    createServerClientMock.mockResolvedValue(
      buildUserSupabase({ user: null, userRow: null })
    );

    const { PATCH } = await import(
      "@/app/api/cases/[id]/confirm-field/route"
    );

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(401);
  });

  it("AC19: returns 404 when case belongs to different tenant (IDOR defense)", async () => {
    // User is authenticated but case returns null (RLS filters it out)
    createServerClientMock.mockResolvedValue(
      buildUserSupabase({ caseRow: null })
    );
    createServiceClientMock.mockReturnValue(buildServiceSupabase());

    const { PATCH } = await import(
      "@/app/api/cases/[id]/confirm-field/route"
    );

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 when request body is invalid", async () => {
    createServerClientMock.mockResolvedValue(buildUserSupabase({}));

    const { PATCH } = await import(
      "@/app/api/cases/[id]/confirm-field/route"
    );

    const response = await PATCH(
      makeRequest({ field_key: "", value: "test", action: "invalid_action" }),
      makeContext()
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });
});
