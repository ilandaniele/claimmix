/**
 * Integration-style Vitest tests for the email extraction worker — bugfix scenarios.
 *
 * INT-1: Bug pattern — extracted_fields populated but fields[] empty.
 *        Worker must hydrate fields[] from extracted_fields before DB write.
 *
 * INT-2: Only fields[] populated (not extracted_fields).
 *        Customer matcher still receives full_name.
 *
 * These tests mock Supabase service client + extractEmailClaim.
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

// ── Supabase service client mock ──────────────────────────────────────────────

/** Captured upsert calls for extracted_fields table */
let capturedFieldUpserts: Array<Array<{ field_key: string; field_value: string; confidence: number }>> = [];
/** Captured customerMatcher input */
let capturedCustomerMatcherInput: Record<string, string | undefined> = {};

function buildServiceMock() {
  capturedFieldUpserts = [];
  capturedCustomerMatcherInput = {};

  return {
    from: (table: string) => {
      if (table === "cases") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: {
              id: "case-001",
              status: "recibido",
              claim_type: "choque",
              tenant_id: "tenant-001",
              channel: "email",
              email_thread_id: "thread-001",
              policyholder_name: null,
              policy_number: null,
            },
            error: null,
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      if (table === "raw_messages") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: {
              body: "Buenos días. Soy NICOLAS JASPER. DU Nro.92310691. Siniestro 91520998-2.",
              subject: "Siniestro Zurich",
              from_addr: "n10jasper@gmail.com",
            },
            error: null,
          }),
        };
      }
      if (table === "claim_memory") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST116" } }),
        };
      }
      if (table === "known_claim_patterns") {
        return {
          select: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }
      if (table === "extracted_fields") {
        return {
          upsert: vi.fn().mockImplementation((rows: Array<{ field_key: string; field_value: string; confidence: number }>) => {
            capturedFieldUpserts.push(rows);
            return Promise.resolve({ error: null });
          }),
        };
      }
      if (table === "missing_docs") {
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
        };
      }
      // Default fallback for any other table
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        upsert: vi.fn().mockResolvedValue({ error: null }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
    },
  };
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

// ── Import worker after all mocks are set up ──────────────────────────────────

import { runEmailExtractionWorker } from "@/server/worker/extract";
import { createServiceClient } from "@/lib/supabase/service";
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("INT-1: Worker hydrates fields[] from extracted_fields when fields[] is empty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure MOCK_AI is NOT set — we want the real extractor path
    delete process.env.MOCK_AI;
    process.env.OPENAI_API_KEY = "test-key";

    const mockSupabase = buildServiceMock();
    vi.mocked(createServiceClient).mockReturnValue(mockSupabase as any);

    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockExtractEmailClaim.mockResolvedValue(makeBugPatternClaim());
    mockFindCustomerMatches.mockResolvedValue([]);
    mockFindPolicyMatches.mockResolvedValue([]);
  });

  it("upserts full_name to extracted_fields DB table", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allUpserted = capturedFieldUpserts.flat();
    const fullNameRow = allUpserted.find((r) => r.field_key === "full_name");

    expect(fullNameRow).toBeDefined();
    expect(fullNameRow?.field_value).toBe("NICOLAS JASPER");
    expect(fullNameRow?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("upserts dni to extracted_fields DB table", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allUpserted = capturedFieldUpserts.flat();
    const dniRow = allUpserted.find((r) => r.field_key === "dni");

    expect(dniRow).toBeDefined();
    expect(dniRow?.field_value).toBe("92310691");
    expect(dniRow?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("upserts policy_number to extracted_fields DB table", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allUpserted = capturedFieldUpserts.flat();
    const policyRow = allUpserted.find((r) => r.field_key === "policy_number");

    expect(policyRow).toBeDefined();
    expect(policyRow?.field_value).toBe("91520998-2");
    expect(policyRow?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("upserts email to extracted_fields DB table", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allUpserted = capturedFieldUpserts.flat();
    const emailRow = allUpserted.find((r) => r.field_key === "email");

    expect(emailRow).toBeDefined();
    expect(emailRow?.field_value).toBe("n10jasper@gmail.com");
  });

  it("all upserted fields have confidence >= HIGH_CONFIDENCE_THRESHOLD (0.60)", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allUpserted = capturedFieldUpserts.flat();
    expect(allUpserted.length).toBeGreaterThan(0);

    for (const row of allUpserted) {
      expect(row.confidence, `field '${row.field_key}' confidence below threshold`).toBeGreaterThanOrEqual(0.60);
    }
  });

  it("uses field_confidences values when available (not always 0.85)", async () => {
    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    const allUpserted = capturedFieldUpserts.flat();
    const fullNameRow = allUpserted.find((r) => r.field_key === "full_name");
    const dniRow = allUpserted.find((r) => r.field_key === "dni");

    // field_confidences.full_name = 0.95, field_confidences.dni = 0.92
    expect(fullNameRow?.confidence).toBeCloseTo(0.95, 1);
    expect(dniRow?.confidence).toBeCloseTo(0.92, 1);
  });
});

describe("INT-2: Customer matcher receives full_name even when only in fields[]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MOCK_AI;
    process.env.OPENAI_API_KEY = "test-key";

    const mockSupabase = buildServiceMock();
    vi.mocked(createServiceClient).mockReturnValue(mockSupabase as any);

    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockFindCustomerMatches.mockImplementation((_, __, fields: Record<string, string | undefined>) => {
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
