/**
 * Integration-style Vitest tests for the email extraction worker — bugfix scenarios.
 *
 * INT-1: Bug pattern — extracted_fields populated but fields[] empty.
 *        Worker must hydrate fields[] from extracted_fields before DB write.
 *
 * INT-2: Only fields[] populated (not extracted_fields).
 *        Customer matcher still receives full_name.
 *
 * These tests mock @/lib/db (Drizzle) + extractEmailClaim.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  mockExtractEmailClaim,
  mockCheckBudget,
  mockFindCustomerMatches,
  mockFindPolicyMatches,
} = vi.hoisted(() => ({
  mockExtractEmailClaim: vi.fn(),
  mockCheckBudget: vi.fn(),
  mockFindCustomerMatches: vi.fn(),
  mockFindPolicyMatches: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/server/ai/openai-extractor", () => ({
  extractEmailClaim: mockExtractEmailClaim,
  OpenAIExtractionError: class OpenAIExtractionError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "OpenAIExtractionError";
    }
  },
}));

vi.mock("@/server/ai/mock-extractor", () => ({
  extractEmailClaimMock: vi.fn(),
  runMockExtractor: vi.fn(),
}));

vi.mock("@/server/ai/budget", () => ({
  checkBudget: mockCheckBudget,
  recordUsage: vi.fn().mockResolvedValue(undefined),
  computeCostUsd: vi.fn().mockReturnValue(0),
}));

vi.mock("@/server/matching/customer-matcher", () => ({
  findCustomerMatches: mockFindCustomerMatches,
}));

vi.mock("@/server/matching/policy-matcher", () => ({
  findPolicyMatches: mockFindPolicyMatches,
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    SPECIALIST_REQUIRED: "claim.specialist_required",
    MEMORY_APPLIED: "claim.memory_applied",
    EXTRACTION_COMPLETE: "claim.extraction_complete",
    AI_BUDGET_EXCEEDED: "ai.budget_exceeded",
    AI_EXTRACTED: "ai.extracted",
  },
}));

vi.mock("@/server/confirmations/orchestrate", () => ({
  orchestratePostExtraction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/ai/gemini-extractor", () => ({
  extractEmailClaimGemini: vi.fn(),
  runGeminiExtractor: vi.fn(),
  GeminiExtractionError: class GeminiExtractionError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "GeminiExtractionError";
    }
  },
}));

vi.mock("@/server/ai/provider", () => ({
  resolveExtractionEngine: vi.fn().mockResolvedValue("openai"),
}));

vi.mock("@/server/ai/severity-classifier", () => ({
  classifySeverity: vi.fn().mockReturnValue("medium"),
  requiresSpecialist: vi.fn().mockReturnValue(false),
}));

vi.mock("@/server/cases/fsm", () => ({
  isValidTransition: vi.fn().mockReturnValue(true),
}));

vi.mock("@/server/agents/training", () => ({
  loadAgentTraining: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/server/training/prompt-rules", () => ({
  loadActivePromptRules: vi.fn().mockResolvedValue([]),
  formatPromptRules: vi.fn().mockReturnValue(""),
}));

vi.mock("@/server/training/examples", () => ({
  loadApprovedExamples: vi.fn().mockResolvedValue([]),
  formatApprovedExamples: vi.fn().mockReturnValue(""),
}));

vi.mock("@/server/training/prompt-version", () => ({
  getActivePromptVersion: vi.fn().mockResolvedValue({ id: null, version: null, systemPrompt: null }),
}));

vi.mock("@/server/training/trainability", () => ({
  assessTrainability: vi.fn().mockReturnValue({ trainable: false }),
}));

vi.mock("@/server/training/agent-runs", () => ({
  logAgentRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/memory/load", () => ({
  loadMemoryHints: vi.fn().mockResolvedValue([]),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

/** Captured insert calls for extracted_fields table */
let capturedFieldInserts: Array<Array<{ field_key: string; field_value: string; confidence: string | number }>> = [];
/** Captured customerMatcher input */
let capturedCustomerMatcherInput: Record<string, string | undefined> = {};

function buildDbMock() {
  capturedFieldInserts = [];
  capturedCustomerMatcherInput = {};

  let selectCallIdx = 0;

  const caseRow = {
    id: "case-001",
    status: "recibido",
    claim_type: "choque",
    tenant_id: "tenant-001",
    channel: "email",
    email_thread_id: "thread-001",
    policyholder_name: null,
    policy_number: null,
  };

  const rawMessageRow = {
    body: "Buenos días. Soy NICOLAS JASPER. DU Nro.92310691. Siniestro 91520998-2.",
    subject: "Siniestro Zurich",
    from_addr: "n10jasper@gmail.com",
  };

  const mockSelect = vi.fn().mockImplementation(() => {
    selectCallIdx++;
    const idx = selectCallIdx;

    const limitFn = vi.fn().mockImplementation(() => {
      if (idx === 1) return Promise.resolve([caseRow]);
      // idx === 2 is raw_messages
      if (idx === 2) return Promise.resolve([rawMessageRow]);
      return Promise.resolve([]);
    });

    const orderByFn = vi.fn().mockReturnValue({
      limit: vi.fn().mockImplementation(() => {
        if (idx === 2) return Promise.resolve([rawMessageRow]);
        return Promise.resolve([]);
      }),
    });

    const whereFn = vi.fn().mockReturnValue({
      limit: limitFn,
      orderBy: orderByFn,
    });

    const andWhereFn = vi.fn().mockReturnValue({
      limit: limitFn,
      orderBy: orderByFn,
      where: whereFn,
    });

    const fromFn = vi.fn().mockReturnValue({ where: andWhereFn });

    return { from: fromFn };
  });

  const mockInsert = vi.fn().mockImplementation((table: unknown) => {
    // Detect if it's an extracted_fields insert by checking the table reference
    const tableObj = table as { [key: string]: unknown };
    const tableName = tableObj?._ ? String(tableObj._) : "";
    const isExtractedFields = tableName.includes("extracted_fields") ||
      // We'll rely on capturing all inserts and let the test filter by field_key presence
      true;

    return {
      values: vi.fn().mockImplementation((rows: unknown) => {
        const rowArray = Array.isArray(rows) ? rows : [rows];
        // Detect extracted_fields inserts by checking for field_key property
        if (rowArray.length > 0 && "field_key" in (rowArray[0] as object)) {
          capturedFieldInserts.push(rowArray as Array<{ field_key: string; field_value: string; confidence: string | number }>);
        }
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue({ rowCount: rowArray.length }),
          onConflictDoNothing: vi.fn().mockResolvedValue({ rowCount: 0 }),
          returning: vi.fn().mockResolvedValue([]),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve([]).then(resolve),
        };
      }),
    };
  });

  const mockUpdate = vi.fn().mockImplementation(() => ({
    set: vi.fn().mockImplementation((data: unknown) => ({
      where: vi.fn().mockResolvedValue({ rowCount: 1 }),
    })),
  }));

  return {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowCount: 0 }) }),
    $count: vi.fn().mockResolvedValue(0),
  };
}

vi.mock("@/lib/db", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    $count: vi.fn(),
  };
  return {
    db: mockDb,
    tables: {},
  };
});

// ── Import worker after all mocks are set up ──────────────────────────────────

import { runEmailExtractionWorker } from "@/server/worker/extract";
import { db } from "@/lib/db";
import { findCustomerMatches } from "@/server/matching/customer-matcher";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBugPatternClaim(): ExtractedClaim {
  // BUG PATTERN: extracted_fields populated, fields[] empty
  return {
    extraction_model: "gpt-4o-mini",
    is_claim: true,
    confidence: 0.95,
    fields: [], // <-- BUG: empty
    extracted_fields: {
      full_name: "NICOLAS JASPER",
      email: "n10jasper@gmail.com",
      phone: "",
      dni: "92310691",
      policy_number: "91520998-2",
      accident_date: "2024-03-15",
      accident_location: "Av. Cabildo",
      accident_description: "Choque entre dos vehículos",
      claim_type: "choque",
    },
    field_confidences: {
      full_name: 0.95,
      email: 0.90,
      dni: 0.92,
      policy_number: 0.93,
      accident_date: 0.85,
      accident_location: 0.80,
      accident_description: 0.85,
      claim_type: 0.95,
    },
    missing_fields: [],
    fields_pending_confirmation: [],
    possible_customer_matches: [],
    possible_policy_matches: [],
    severity: "medium",
    requires_specialist: false,
    not_relevant_reason: undefined,
    summary: "Caso de choque. El asegurado reportó el incidente.",
    suggested_reply: "Estimado asegurado, hemos recibido su reclamo.",
    prompt_tokens: 500,
    completion_tokens: 200,
    cost_usd: 0.0001,
  };
}

function setupDbMock() {
  const freshDb = buildDbMock();
  vi.mocked(db).select = freshDb.select as any;
  vi.mocked(db).insert = freshDb.insert as any;
  vi.mocked(db).update = freshDb.update as any;
  vi.mocked(db).delete = freshDb.delete as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("INT-1: Worker hydrates fields[] from extracted_fields when fields[] is empty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure MOCK_AI is NOT set — we want the real extractor path
    delete process.env.MOCK_AI;
    process.env.OPENAI_API_KEY = "test-key";

    setupDbMock();

    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockExtractEmailClaim.mockResolvedValue(makeBugPatternClaim());
    mockFindCustomerMatches.mockResolvedValue([]);
    mockFindPolicyMatches.mockResolvedValue([]);
  });

  it("upserts full_name to extracted_fields DB table", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allInserted = capturedFieldInserts.flat();
    const fullNameRow = allInserted.find((r) => r.field_key === "full_name");

    expect(fullNameRow).toBeDefined();
    expect(fullNameRow?.field_value).toBe("NICOLAS JASPER");
    expect(Number(fullNameRow?.confidence)).toBeGreaterThanOrEqual(0.85);
  });

  it("upserts dni to extracted_fields DB table", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allInserted = capturedFieldInserts.flat();
    const dniRow = allInserted.find((r) => r.field_key === "dni");

    expect(dniRow).toBeDefined();
    expect(dniRow?.field_value).toBe("92310691");
    expect(Number(dniRow?.confidence)).toBeGreaterThanOrEqual(0.85);
  });

  it("upserts policy_number to extracted_fields DB table", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allInserted = capturedFieldInserts.flat();
    const policyRow = allInserted.find((r) => r.field_key === "policy_number");

    expect(policyRow).toBeDefined();
    expect(policyRow?.field_value).toBe("91520998-2");
    expect(Number(policyRow?.confidence)).toBeGreaterThanOrEqual(0.85);
  });

  it("upserts email to extracted_fields DB table", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allInserted = capturedFieldInserts.flat();
    const emailRow = allInserted.find((r) => r.field_key === "email");

    expect(emailRow).toBeDefined();
    expect(emailRow?.field_value).toBe("n10jasper@gmail.com");
  });

  it("all upserted fields have confidence >= HIGH_CONFIDENCE_THRESHOLD (0.60)", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allInserted = capturedFieldInserts.flat();
    expect(allInserted.length).toBeGreaterThan(0);

    for (const row of allInserted) {
      expect(Number(row.confidence), `field '${row.field_key}' confidence below threshold`).toBeGreaterThanOrEqual(0.60);
    }
  });

  it("uses field_confidences values when available (not always 0.85)", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allInserted = capturedFieldInserts.flat();
    const fullNameRow = allInserted.find((r) => r.field_key === "full_name");
    const dniRow = allInserted.find((r) => r.field_key === "dni");

    // field_confidences.full_name = 0.95, field_confidences.dni = 0.92
    expect(Number(fullNameRow?.confidence)).toBeCloseTo(0.95, 1);
    expect(Number(dniRow?.confidence)).toBeCloseTo(0.92, 1);
  });
});

describe("INT-2: Customer matcher receives full_name even when only in fields[]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MOCK_AI;
    process.env.OPENAI_API_KEY = "test-key";

    setupDbMock();

    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockFindCustomerMatches.mockImplementation((_tenantId: string, fields: Record<string, string | undefined>) => {
      capturedCustomerMatcherInput = fields;
      return Promise.resolve([]);
    });
    mockFindPolicyMatches.mockResolvedValue([]);
  });

  it("customer matcher receives full_name when it is only in fields[] (not extracted_fields)", async () => {
    // Model returned full_name only in fields[], NOT in extracted_fields
    const claimWithFieldsOnly: ExtractedClaim = {
      extraction_model: "gpt-4o-mini",
      is_claim: true,
      confidence: 0.92,
      fields: [
        { field_key: "full_name", field_value: "NICOLAS JASPER", confidence: 0.9, source: "ai" },
        { field_key: "accident_date", field_value: "2024-03-15", confidence: 0.85, source: "ai" },
      ],
      extracted_fields: undefined, // not in typed object
      field_confidences: {},
      missing_fields: [],
      fields_pending_confirmation: [],
      possible_customer_matches: [],
      possible_policy_matches: [],
      severity: "medium",
      requires_specialist: false,
      not_relevant_reason: undefined,
      summary: "",
      suggested_reply: "",
      prompt_tokens: 300,
      completion_tokens: 100,
      cost_usd: 0.00005,
    };

    mockExtractEmailClaim.mockResolvedValue(claimWithFieldsOnly);

    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    expect(capturedCustomerMatcherInput.full_name).toBe("NICOLAS JASPER");
  });
});
