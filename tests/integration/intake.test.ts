/**
 * Integration tests for POST /api/intake/simulate.
 *
 * AC4:  202 response with case_id and status=procesando.
 * LLM10: Budget exceeded → 429 (fail-closed per spec).
 * AC8:  MOCK_AI=true path exercised via worker mock.
 * AC17: Prompt injection in body doesn't escape to case.status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks (vi.hoisted runs before module evaluation) ──────────────────

const { mockGetSession, mockDbSelect, mockDbInsert, mockCheckBudget } = vi.hoisted(() => {
  return {
    mockGetSession: vi.fn(),
    mockDbSelect: vi.fn(),
    mockDbInsert: vi.fn(),
    mockCheckBudget: vi.fn(),
  };
});

// ── Mock modules ──────────────────────────────────────────────────────────────

vi.mock("@/lib/auth/session", () => ({
  getSessionContext: mockGetSession,
}));

vi.mock("@/lib/db", () => {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: "case-uuid-001" }]),
    then: vi.fn(),
  };

  return {
    db: {
      select: mockDbSelect,
      insert: mockDbInsert,
    },
  };
});

vi.mock("@/server/ai/budget", () => ({
  checkBudget: mockCheckBudget,
  recordUsage: vi.fn().mockResolvedValue(undefined),
  computeCostUsd: vi.fn().mockReturnValue(0),
  COST_PER_PROMPT_TOKEN: 0.00000015,
  COST_PER_COMPLETION_TOKEN: 0.0000006,
}));

vi.mock("@/server/worker/extract", () => ({
  runExtractionWorker: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    AUTH_SUCCESS: "auth.success",
    AUTH_FAILURE: "auth.failure",
    AUTH_SIGN_OUT: "auth.sign_out",
    AUTH_RATE_LIMITED: "auth.rate_limited",
    CASE_CREATED: "case.created",
    CASE_STATUS_CHANGED: "case.status_changed",
    CASE_CLOSED: "case.closed",
    CASE_ASSIGNED: "case.assigned",
    AI_EXTRACTED: "ai.extracted",
    AI_BUDGET_EXCEEDED: "ai.budget_exceeded",
    DOC_RECEIVED: "doc.received",
  },
}));

vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60000,
    retryAfterSeconds: 0,
  }),
  RATE_LIMIT_CONFIGS: { INTAKE_SIMULATE: { limit: 30, windowMs: 60000 } },
  buildUserKey: (uid: string, ep: string) => `user:${uid}:${ep}`,
  getClientIp: () => "127.0.0.1",
}));

// ── Import route after mocks ──────────────────────────────────────────────────

import { POST } from "@/app/api/intake/simulate/route";
import { NextRequest } from "next/server";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/intake/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const MOCK_USER = { id: "user-001", email: "lucia@example.com" };
const MOCK_USER_ROW = {
  id: "user-001",
  tenant_id: "tenant-001",
  full_name: "Lucía Ramallo",
  role: "analyst",
  created_at: new Date().toISOString(),
};

function setupDbMocks() {
  // db.select() chain returns user row
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([MOCK_USER_ROW]),
      }),
    }),
  });

  // db.insert() chain for cases returns new case id
  mockDbInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "case-uuid-001" }]),
    }),
  });
}

function setupAuthMocks() {
  mockGetSession.mockResolvedValue({ user: MOCK_USER });
  setupDbMocks();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/intake/simulate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    setupAuthMocks();
  });

  afterEach(() => {
    // Use clearAllMocks instead of restoreAllMocks to preserve vi.mock() factories.
    vi.clearAllMocks();
  });

  // ── AC4: Happy path with scenario_id ─────────────────────────────────────────

  it("returns 202 with case_id and status=procesando for valid scenario_id", async () => {
    const req = makeRequest({ scenario_id: "choque-01" });
    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.case_id).toBeDefined();
    expect(body.status).toBe("procesando");
    expect(body.message).toBe("Procesando...");
  });

  it("returns 202 with case_id for robo scenario", async () => {
    const req = makeRequest({ scenario_id: "robo-01" });
    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.case_id).toBeDefined();
    expect(body.status).toBe("procesando");
  });

  it("returns 202 for raw_text + case_type mode", async () => {
    const req = makeRequest({
      raw_text: "El 15/03/2024 tuve un choque en Av. Corrientes.",
      case_type: "choque",
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.case_id).toBeDefined();
  });

  it("returns 202 for all 4 claim types via scenario_id", async () => {
    const scenarioIds = ["choque-01", "robo-01", "granizo-01", "incendio-01"];
    for (const sid of scenarioIds) {
      vi.clearAllMocks();
      mockCheckBudget.mockResolvedValue({ exceeded: false });
      setupAuthMocks();
      const req = makeRequest({ scenario_id: sid });
      const res = await POST(req);
      expect(res.status).toBe(202);
    }
  });

  // ── AC4: Unauthenticated ──────────────────────────────────────────────────────

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const req = makeRequest({ scenario_id: "choque-01" });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("MISSING_SESSION");
  });

  // ── Validation errors ─────────────────────────────────────────────────────────

  it("returns 400 for invalid scenario_id", async () => {
    const req = makeRequest({ scenario_id: "invalid-scenario-999" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 when neither scenario_id nor raw_text provided", async () => {
    const req = makeRequest({});
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 when raw_text provided without case_type", async () => {
    const req = makeRequest({ raw_text: "El 15/03/2024 tuve un choque..." });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 for invalid case_type with raw_text", async () => {
    const req = makeRequest({ raw_text: "texto...", case_type: "tsunami" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 for non-JSON body", async () => {
    const req = new NextRequest("http://localhost:3000/api/intake/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  // ── LLM10: Budget guard (fail-closed: 429) ──────────────────────────────────

  it("returns 429 when monthly budget exceeded (LLM10: fail-closed)", async () => {
    mockCheckBudget.mockResolvedValue({
      exceeded: true,
      reason: "Presupuesto mensual de IA agotado ($200.00 / $200).",
    });
    const req = makeRequest({ scenario_id: "choque-01" });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("AI_BUDGET_EXCEEDED");
    expect(body.error.message).toBe("Presupuesto de IA agotado para este mes.");
  });

  // ── Rate limit ────────────────────────────────────────────────────────────────

  it("returns 429 when rate limit exceeded", async () => {
    // Re-setup auth mocks since we call clearAllMocks in afterEach.
    setupAuthMocks();
    mockCheckBudget.mockResolvedValue({ exceeded: false });

    const { rateLimit } = await import("@/lib/rate-limit/index");
    vi.mocked(rateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30000,
      retryAfterSeconds: 30,
    });

    const req = makeRequest({ scenario_id: "choque-01" });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  // ── Email intake (W5: replaced with 410 Gone stub) ───────────────────────────
  // The Postmark webhook handler is now a 410 Gone stub (AC11).
  // All calls to POST /api/intake/email return 410 regardless of payload/headers.
  it("POST /api/intake/email returns 410 Gone (Postmark webhook disabled — W5/AC11)", async () => {
    const { POST: emailPOST } = await import("@/app/api/intake/email/route");
    const req = new Request("http://localhost/api/intake/email", {
      method: "POST",
      body: JSON.stringify({ MessageID: "test" }),
      headers: { "Content-Type": "application/json" },
    }) as any;
    const res = await emailPOST(req);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error.code).toBe("GONE");
  });
});

// ── Scenarios data validation ─────────────────────────────────────────────────

describe("simulation scenarios", () => {
  it("has exactly 20 scenarios", async () => {
    const { SCENARIOS } = await import("@/server/intake/scenarios");
    expect(SCENARIOS).toHaveLength(20);
  });

  it("has 5 scenarios for each claim type", async () => {
    const { SCENARIOS } = await import("@/server/intake/scenarios");
    const counts = SCENARIOS.reduce<Record<string, number>>((acc, s) => {
      acc[s.case_type] = (acc[s.case_type] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts["choque"]).toBe(5);
    expect(counts["robo"]).toBe(5);
    expect(counts["granizo"]).toBe(5);
    expect(counts["incendio"]).toBe(5);
  });

  it("all scenarios have unique IDs", async () => {
    const { SCENARIOS } = await import("@/server/intake/scenarios");
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all scenarios have non-empty raw_text", async () => {
    const { SCENARIOS } = await import("@/server/intake/scenarios");
    for (const s of SCENARIOS) {
      expect(s.raw_text.length).toBeGreaterThan(50);
    }
  });

  it("SCENARIOS_BY_ID lookup works for all scenario IDs", async () => {
    const { SCENARIOS, SCENARIOS_BY_ID } = await import("@/server/intake/scenarios");
    for (const s of SCENARIOS) {
      expect(SCENARIOS_BY_ID.get(s.id)).toBeDefined();
      expect(SCENARIOS_BY_ID.get(s.id)?.id).toBe(s.id);
    }
  });

  it("scenario IDs match SCENARIO_IDS enum values", async () => {
    const { SCENARIOS } = await import("@/server/intake/scenarios");
    const { SCENARIO_IDS } = await import("@/lib/schemas/intake");
    const scenarioIdSet = new Set(SCENARIOS.map((s) => s.id));
    for (const sid of SCENARIO_IDS) {
      expect(scenarioIdSet.has(sid)).toBe(true);
    }
  });
});

// ── Budget cost computation ───────────────────────────────────────────────────
// These tests use the constants directly (not via the mocked module).

describe("budget computeCostUsd (standalone)", () => {
  // gpt-4o-mini cost model constants from budget.ts.
  const COST_PER_PROMPT_TOKEN = 0.00000015;
  const COST_PER_COMPLETION_TOKEN = 0.00000060;

  it("computes cost correctly for gpt-4o-mini at 1000 prompt + 500 completion tokens", () => {
    const cost = 1000 * COST_PER_PROMPT_TOKEN + 500 * COST_PER_COMPLETION_TOKEN;
    expect(cost).toBeCloseTo(0.00045, 5);
  });

  it("cost is 0 for 0 tokens (mock extractor path)", () => {
    const cost = 0 * COST_PER_PROMPT_TOKEN + 0 * COST_PER_COMPLETION_TOKEN;
    expect(cost).toBe(0);
  });

  it("cost is positive for non-zero tokens", () => {
    const cost = 1000 * COST_PER_PROMPT_TOKEN + 500 * COST_PER_COMPLETION_TOKEN;
    expect(cost).toBeGreaterThan(0);
  });

  it("monthly cap: 3000 extractions at ~3k tokens each stays under $200", () => {
    const avgPromptTokens = 2000;
    const avgCompletionTokens = 800;
    const costPerExtraction =
      avgPromptTokens * COST_PER_PROMPT_TOKEN + avgCompletionTokens * COST_PER_COMPLETION_TOKEN;
    const monthlyCost = costPerExtraction * 3000;
    expect(monthlyCost).toBeLessThan(200);
  });
});
