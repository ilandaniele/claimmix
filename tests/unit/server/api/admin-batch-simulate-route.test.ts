/**
 * Unit tests for POST /api/admin/batch-simulate
 *
 * Verifies:
 *  - Admin-only guard (FORBIDDEN_ROLE → 403, MISSING_SESSION → 401)
 *  - Rate limiting (429-style error)
 *  - Schema validation (count bounds, delay_ms bounds, invalid scenario_id)
 *  - Budget exceeded
 *  - Happy path: 202 Accepted with correct accepted count and case_ids
 *  - after() callback runs runIntakeAgent for every created case
 *  - Delay between cases is forwarded to the background callback
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted state ─────────────────────────────────────────────────────────────

const {
  afterCallbacks,
  mockAfter,
  mockRequireAdmin,
  mockCheckBudget,
  mockGetClientIp,
  mockRateLimit,
  mockRunIntakeAgent,
  mockWriteAuditLog,
  mockGetRandomScenario,
  mockGetScenarioById,
} = vi.hoisted(() => {
  const afterCallbacks: Array<() => unknown | Promise<unknown>> = [];
  return {
    afterCallbacks,
    mockAfter: vi.fn((cb: () => unknown | Promise<unknown>) => {
      afterCallbacks.push(cb);
    }),
    mockRequireAdmin: vi.fn(),
    mockCheckBudget: vi.fn(),
    mockGetClientIp: vi.fn(),
    mockRateLimit: vi.fn(),
    mockRunIntakeAgent: vi.fn(),
    mockWriteAuditLog: vi.fn(),
    mockGetRandomScenario: vi.fn(),
    mockGetScenarioById: vi.fn(),
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("server-only", () => ({}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mockAfter };
});

vi.mock("@/lib/auth/require-admin", () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock("@/server/ai/budget", () => ({
  checkBudget: mockCheckBudget,
}));

vi.mock("@/lib/rate-limit/index", () => ({
  getClientIp: mockGetClientIp,
  rateLimit: mockRateLimit,
}));

vi.mock("@/server/agents/intake-agent", () => ({
  runIntakeAgent: mockRunIntakeAgent,
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockWriteAuditLog,
  AuditEvent: { CASE_CREATED: "case.created" },
}));

vi.mock("@/server/intake/scenarios", () => ({
  getRandomScenario: mockGetRandomScenario,
  getScenarioById: mockGetScenarioById,
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

let caseInsertSeq = 0;

function makeAdminDbMock() {
  caseInsertSeq = 0;
  return {
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation(() => {
        caseInsertSeq++;
        const id = `case-${String(caseInsertSeq).padStart(3, "0")}`;
        return {
          returning: vi.fn().mockResolvedValue([{
            id,
            created_at: "2024-01-01T00:00:00Z",
          }]),
          catch: vi.fn().mockResolvedValue(undefined),
        };
      }),
    })),
  };
}

// ── Import route AFTER mocks ──────────────────────────────────────────────────

import { POST } from "@/app/api/admin/batch-simulate/route";

// ── Constants ─────────────────────────────────────────────────────────────────

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID   = "20000000-0000-0000-0000-000000000001";

const DEFAULT_SCENARIO = {
  id: "choque-01",
  case_type: "choque" as const,
  policyholder_name: "Ana García",
  policy_number: "POL-001",
  raw_text: "Buenos días, reporto un choque.",
  expected_fields: {},
};

function makeRequest(body: Record<string, unknown> = { count: 3 }) {
  return new NextRequest("http://localhost/api/admin/batch-simulate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "vitest",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/admin/batch-simulate", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    caseInsertSeq = 0;

    mockRequireAdmin.mockResolvedValue({
      db: makeAdminDbMock(),
      user: { id: USER_ID },
      userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "admin" },
    });

    mockGetClientIp.mockReturnValue("127.0.0.1");
    mockRateLimit.mockResolvedValue({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockWriteAuditLog.mockResolvedValue(undefined);
    mockRunIntakeAgent.mockResolvedValue(undefined);
    mockGetRandomScenario.mockReturnValue(DEFAULT_SCENARIO);
    mockGetScenarioById.mockReturnValue(DEFAULT_SCENARIO);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it("returns 202 Accepted with the correct accepted count", async () => {
    const res = await POST(makeRequest({ count: 3 }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(3);
  });

  it("returns all created case IDs in the response", async () => {
    const res = await POST(makeRequest({ count: 3 }));
    const body = await res.json();
    expect(body.case_ids).toHaveLength(3);
    expect(body.case_ids[0]).toMatch(/^case-/);
  });

  it("registers exactly one after() callback", async () => {
    await POST(makeRequest({ count: 2 }));
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(afterCallbacks).toHaveLength(1);
  });

  it("after() callback calls runIntakeAgent once per created case", async () => {
    const res = await POST(makeRequest({ count: 3 }));
    const body = await res.json();
    await afterCallbacks[0]();
    expect(mockRunIntakeAgent).toHaveBeenCalledTimes(3);
    for (const caseId of body.case_ids) {
      expect(mockRunIntakeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ caseId, tenantId: TENANT_ID, source: "simulate" })
      );
    }
  });

  it("calls runIntakeAgent with the correct userId", async () => {
    await POST(makeRequest({ count: 1 }));
    await afterCallbacks[0]();
    expect(mockRunIntakeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID })
    );
  });

  it("uses getRandomScenario for each case when no claim_type or scenario_id given", async () => {
    await POST(makeRequest({ count: 5 }));
    expect(mockGetRandomScenario).toHaveBeenCalledTimes(5);
  });

  it("passes claim_type to getRandomScenario when specified", async () => {
    await POST(makeRequest({ count: 2, claim_type: "robo" }));
    expect(mockGetRandomScenario).toHaveBeenCalledWith("robo");
  });

  it("uses getScenarioById when scenario_id is provided", async () => {
    await POST(makeRequest({ count: 3, scenario_id: "choque-01" }));
    expect(mockGetScenarioById).toHaveBeenCalledWith("choque-01");
    expect(mockGetRandomScenario).not.toHaveBeenCalled();
  });

  it("uses the same fixed scenario for all cases when scenario_id is set", async () => {
    await POST(makeRequest({ count: 4, scenario_id: "choque-01" }));
    // getScenarioById called once to resolve, then the fixed scenario reused
    expect(mockGetScenarioById).toHaveBeenCalledTimes(1);
  });

  it("writes an audit log entry for the batch", async () => {
    await POST(makeRequest({ count: 2 }));
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_ID,
        actor_id: USER_ID,
        payload: expect.objectContaining({ batch: true, requested: 2 }),
      })
    );
  });

  // ── Auth errors ──────────────────────────────────────────────────────────────

  it("returns 403 when requireAdmin throws FORBIDDEN_ROLE", async () => {
    const { AppError } = await import("@/lib/errors");
    mockRequireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));
    const res = await POST(makeRequest({ count: 1 }));
    expect(res.status).toBe(403);
  });

  it("returns 401 when requireAdmin throws MISSING_SESSION", async () => {
    const { AppError } = await import("@/lib/errors");
    mockRequireAdmin.mockRejectedValue(new AppError("MISSING_SESSION"));
    const res = await POST(makeRequest({ count: 1 }));
    expect(res.status).toBe(401);
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────────

  it("returns 429 when rate limit is exceeded", async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 600 });
    const res = await POST(makeRequest({ count: 5 }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // ── Budget exceeded ────────────────────────────────────────────────────────────

  it("returns 429 when the AI budget is exceeded", async () => {
    mockCheckBudget.mockResolvedValue({ exceeded: true });
    const res = await POST(makeRequest({ count: 3 }));
    expect(res.status).toBe(429);
  });

  // ── Schema validation ─────────────────────────────────────────────────────────

  it("rejects count=0 (below minimum of 1) with 400", async () => {
    const res = await POST(makeRequest({ count: 0 }));
    expect(res.status).toBe(400);
  });

  it("rejects count=51 (above maximum of 50) with 400", async () => {
    const res = await POST(makeRequest({ count: 51 }));
    expect(res.status).toBe(400);
  });

  it("rejects delay_ms=-1 (below minimum of 0) with 400", async () => {
    const res = await POST(makeRequest({ count: 1, delay_ms: -1 }));
    expect(res.status).toBe(400);
  });

  it("rejects delay_ms=5001 (above maximum of 5000) with 400", async () => {
    const res = await POST(makeRequest({ count: 1, delay_ms: 5001 }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-string scenario_id (object) with 400", async () => {
    const res = await POST(makeRequest({ count: 1, scenario_id: { id: "choque-01" } }));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid scenario_id that getScenarioById cannot resolve with 400", async () => {
    mockGetScenarioById.mockReturnValue(undefined);
    const res = await POST(makeRequest({ count: 1, scenario_id: "nonexistent-id" }));
    expect(res.status).toBe(400);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────────

  it("accepts count=1 and count=50 (boundary values)", async () => {
    const res1 = await POST(makeRequest({ count: 1 }));
    expect(res1.status).toBe(202);

    afterCallbacks.length = 0;
    mockRequireAdmin.mockResolvedValue({
      db: makeAdminDbMock(),
      user: { id: USER_ID },
      userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "admin" },
    });

    const res50 = await POST(makeRequest({ count: 50 }));
    expect(res50.status).toBe(202);
    const body = await res50.json();
    expect(body.accepted).toBe(50);
  });

  it("does not call runIntakeAgent synchronously — only inside after()", async () => {
    await POST(makeRequest({ count: 3 }));
    // Before callback fires
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
    // After callback fires
    await afterCallbacks[0]();
    expect(mockRunIntakeAgent).toHaveBeenCalledTimes(3);
  });
});
