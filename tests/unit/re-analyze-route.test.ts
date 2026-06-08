import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  afterCallbacks,
  mockAfter,
  mockCheckBudget,
  mockCreateServerClient,
  mockCreateServiceClient,
  mockGetClientIp,
  mockRateLimit,
  mockRunIntakeAgent,
  mockWriteAuditLog,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown | Promise<unknown>>,
  mockAfter: vi.fn((callback: () => unknown | Promise<unknown>) => {
    afterCallbacks.push(callback);
  }),
  mockCheckBudget: vi.fn(),
  mockCreateServerClient: vi.fn(),
  mockCreateServiceClient: vi.fn(),
  mockGetClientIp: vi.fn(),
  mockRateLimit: vi.fn(),
  mockRunIntakeAgent: vi.fn(),
  mockWriteAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: mockAfter,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: mockCreateServerClient,
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mockCreateServiceClient,
}));

vi.mock("@/server/agents/intake-agent", () => ({
  runIntakeAgent: mockRunIntakeAgent,
}));

vi.mock("@/server/ai/budget", () => ({
  checkBudget: mockCheckBudget,
}));

vi.mock("@/lib/audit/log", () => ({
  AuditEvent: {},
  writeAuditLog: mockWriteAuditLog,
}));

vi.mock("@/lib/rate-limit/index", () => ({
  getClientIp: mockGetClientIp,
  rateLimit: mockRateLimit,
}));

import { POST } from "@/app/api/cases/[id]/re-analyze/route";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

type CaseRow = {
  id: string;
  status: string;
  tenant_id: string;
};

let caseRow: CaseRow;
let caseUpdatePayload: Record<string, unknown> | null;

function makeSelectSingle<T>(data: T) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error: null }),
  };
}

function makeServerClient() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: USER_ID } },
        error: null,
      }),
    },
    from: vi.fn((table: string) => {
      if (table === "users") {
        return makeSelectSingle({
          id: USER_ID,
          tenant_id: TENANT_ID,
          role: "admin",
        });
      }

      if (table === "cases") {
        return makeSelectSingle(caseRow);
      }

      throw new Error(`Unexpected table ${table}`);
    }),
  };
}

function makeServiceClient() {
  return {
    from: vi.fn((table: string) => {
      if (table !== "cases") {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        update: vi.fn((payload: Record<string, unknown>) => {
          caseUpdatePayload = payload;
          return {
            eq: vi.fn().mockResolvedValue({ error: null }),
          };
        }),
      };
    }),
  };
}

function makeRequest() {
  return new NextRequest(`http://localhost/api/cases/${CASE_ID}/re-analyze`, {
    method: "POST",
    headers: {
      "user-agent": "vitest",
      "x-forwarded-for": "127.0.0.1",
    },
  });
}

describe("POST /api/cases/:id/re-analyze", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    caseUpdatePayload = null;
    caseRow = {
      id: CASE_ID,
      status: "listo_para_core",
      tenant_id: TENANT_ID,
    };

    mockCreateServerClient.mockResolvedValue(makeServerClient());
    mockCreateServiceClient.mockReturnValue(makeServiceClient());
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockGetClientIp.mockReturnValue("127.0.0.1");
    mockRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 4,
      retryAfterSeconds: 0,
    });
    mockRunIntakeAgent.mockResolvedValue({ ok: true, action: "extract_email" });
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 202, resets the case, and schedules the intake agent", async () => {
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      case_id: CASE_ID,
      status: "procesando",
    });
    expect(caseUpdatePayload).toMatchObject({ status: "procesando" });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_ID,
        actor_id: USER_ID,
        event_type: "case.re_analyze_triggered",
        target_id: CASE_ID,
        payload: { previous_status: "listo_para_core" },
      })
    );

    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();

    expect(mockRunIntakeAgent).toHaveBeenCalledWith({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      source: "manual",
    });
  });

  it("does not schedule the agent for closed cases", async () => {
    caseRow = {
      id: CASE_ID,
      status: "cerrado",
      tenant_id: TENANT_ID,
    };

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FSM_INVALID_TRANSITION" },
    });
    expect(caseUpdatePayload).toBeNull();
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
  });
});
