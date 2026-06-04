/**
 * Unit tests for AI extractor field-copy + identity guard.
 *
 * Tests the field-copy logic inside runEmailExtractionWorker:
 *   - Lines 661-668 of src/server/worker/extract.ts
 *
 * AC11: Worker copies extracted full_name → cases.policyholder_name
 *       (trimmed, sliced to 200 chars) when case field is NULL.
 * AC12: Worker copies extracted policy_number → cases.policy_number
 *       (trimmed, sliced to 100 chars) when case field is NULL.
 * AC13: Identity guard — worker does NOT overwrite already-populated
 *       policyholder_name with extractor output.
 * AC14: Empty/whitespace extracted values are rejected — no UPDATE attempted
 *       for those fields.
 *
 * Strategy:
 *   - vi.mock (static, hoisted) for all external modules.
 *   - @/server/ai/mock-extractor is mocked so tests can control exactly what
 *     extracted_fields the worker sees on each run.
 *   - The mock Supabase client (injected via createServiceClient mock) captures
 *     the cases.update() payload for assertion.
 *
 * Note: extract.ts is excluded from coverage by vitest.config.ts. Tests
 * still run against the live source — only coverage attribution is skipped.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";

// ── Static module mocks ───────────────────────────────────────────────────────
// vi.mock() calls are hoisted to the top of the file by Vitest.

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    AI_EXTRACTED: "claim.ai_extracted",
    AI_BUDGET_EXCEEDED: "claim.budget_exceeded",
    EXTRACTION_COMPLETE: "claim.extraction_complete",
    SPECIALIST_REQUIRED: "claim.specialist_required",
    MEMORY_APPLIED: "claim.memory_applied",
    OUTBOUND_EMAIL_SENT: "email.outbound_sent",
    OUTBOUND_EMAIL_FAILED: "email.outbound_failed",
    CONFIRMATION_REQUESTED: "claim.confirmation_requested",
    MISSING_INFO_REQUESTED: "claim.missing_info_requested",
  },
}));

vi.mock("@/server/ai/budget", () => ({
  checkBudget: vi.fn().mockResolvedValue({ exceeded: false }),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/matching/customer-matcher", () => ({
  findCustomerMatches: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/server/matching/policy-matcher", () => ({
  findPolicyMatches: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/server/confirmations/orchestrate", () => ({
  orchestratePostExtraction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/cases/fsm", () => ({
  isValidTransition: vi.fn().mockReturnValue(true),
}));

vi.mock("@/server/ai/gap-analysis", () => ({
  analyzeGaps: vi.fn().mockReturnValue({
    recommended_status: "listo",
    confidence_min: 0.9,
    missing_doc_keys: [],
    low_confidence_fields: [],
  }),
}));

vi.mock("@/server/ai/severity-classifier", () => ({
  classifySeverity: vi.fn().mockReturnValue("medium"),
  requiresSpecialist: vi.fn().mockReturnValue(false),
}));

/**
 * Mock the mock-extractor module. extractEmailClaimMock is replaced with a
 * vi.fn() whose implementation is set per-test via mockReturnValue / mockResolvedValue.
 * The worker calls extractEmailClaimMock() when shouldUseMock() is true (no OPENAI_API_KEY).
 */
vi.mock("@/server/ai/mock-extractor", () => ({
  extractEmailClaimMock: vi.fn(),
  runMockExtractor: vi.fn(),
}));

// ── Imports (after vi.mock declarations) ─────────────────────────────────────

import { createServiceClient } from "@/lib/supabase/service";
import { checkBudget } from "@/server/ai/budget";
import { isValidTransition } from "@/server/cases/fsm";
import { classifySeverity, requiresSpecialist } from "@/server/ai/severity-classifier";
import { orchestratePostExtraction } from "@/server/confirmations/orchestrate";
import { findCustomerMatches } from "@/server/matching/customer-matcher";
import { findPolicyMatches } from "@/server/matching/policy-matcher";
import { extractEmailClaimMock } from "@/server/ai/mock-extractor";
import { runEmailExtractionWorker } from "@/server/worker/extract";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const CASE_ID   = "fc-test-0000-0000-0000-000000000001";
const TENANT_ID = "fc-test-0000-0000-0000-000000000002";

/**
 * Build a minimal valid ExtractedClaim with the given extracted_fields.
 * The worker reads extractedClaim.extracted_fields for the field-copy logic.
 */
function makeExtractedClaim(extractedFields: Record<string, string>): ExtractedClaim {
  return {
    extraction_model: "mock-email-v1",
    fields: [],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    is_claim: true,
    confidence: 0.92,
    extracted_fields: extractedFields,
    field_confidences: {},
    missing_fields: [],
    fields_pending_confirmation: [],
    possible_customer_matches: [],
    possible_policy_matches: [],
    severity: "medium",
    requires_specialist: false,
    not_relevant_reason: undefined,
    summary: "Test extraction",
    suggested_reply: "",
  };
}

/**
 * Build a chainable mock Supabase client.
 *
 * caseRow: what the cases SELECT .single() returns.
 * caseUpdateSpy: spy that captures each cases.update(payload) call.
 */
function buildMockClient(
  caseRow: Record<string, unknown>,
  caseUpdateSpy: ReturnType<typeof vi.fn>
) {
  return {
    from: (table: string) => {
      if (table === "cases") {
        return {
          // SELECT branch: fetch case row.
          select: (_cols: string) => ({
            eq: (_c: string, _v: string) => ({
              eq: (_c2: string, _v2: string) => ({
                single: () =>
                  Promise.resolve({ data: caseRow, error: null }),
              }),
            }),
          }),
          // UPDATE branch: called once at the end of the pipeline.
          update: (payload: Record<string, unknown>) => ({
            eq: (_col: string, _val: string) => {
              caseUpdateSpy(payload);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }

      if (table === "raw_messages") {
        return {
          select: (_cols: string) => ({
            eq: (_c: string, _v: string) => ({
              order: (_col: string, _opts: any) => ({
                limit: (_n: number) => ({
                  single: () =>
                    Promise.resolve({
                      data: {
                        body: "Stub email body for field-copy tests.",
                        subject: "Reclamo",
                        from_addr: "cliente@example.com",
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      }

      // All other tables (claim_memory, known_claim_patterns, extracted_fields,
      // missing_docs, outbound_messages, claim_messages) return empty results.
      return {
        select: (_cols: string) => ({
          eq: (_c: string, _v: string) => ({
            eq: (_c2: string, _v2: string) => ({
              order: (_col: string, _opts: any) => ({
                limit: (_n: number) => Promise.resolve({ data: [], error: null }),
              }),
              single: () => Promise.resolve({ data: null, error: null }),
            }),
            limit: (_n: number) => ({
              single: () => Promise.resolve({ data: null, error: null }),
            }),
            order: (_col: string, _opts: any) => ({
              limit: (_n: number) => Promise.resolve({ data: [], error: null }),
            }),
            or: (_expr: string) => ({
              eq: (_c2: string, _v2: string) => ({
                limit: (_n: number) => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
          or: (_expr: string) => ({
            eq: (_c2: string, _v2: string) => ({
              limit: (_n: number) => Promise.resolve({ data: [], error: null }),
            }),
          }),
          limit: (_n: number) => Promise.resolve({ data: [], error: null }),
        }),
        upsert: (_data: any, _opts?: any) => Promise.resolve({ error: null }),
        update: (_data: any) => ({
          eq: (_c: string, _v: string) => Promise.resolve({ error: null }),
        }),
        insert: (_data: any) => Promise.resolve({ error: null }),
      };
    },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Re-apply default implementations after clearAllMocks resets them.
  vi.mocked(checkBudget).mockResolvedValue({ exceeded: false });
  vi.mocked(isValidTransition).mockReturnValue(true);
  vi.mocked(classifySeverity).mockReturnValue("medium");
  vi.mocked(requiresSpecialist).mockReturnValue(false);
  vi.mocked(orchestratePostExtraction).mockResolvedValue(undefined);
  vi.mocked(findCustomerMatches).mockResolvedValue([]);
  vi.mocked(findPolicyMatches).mockResolvedValue([]);
});

// ── Shared test runner ────────────────────────────────────────────────────────

/**
 * Run the email extraction worker with the given case row and extracted fields.
 * Returns the captured cases.update() call payloads.
 */
async function runWorker(
  caseRow: Record<string, unknown>,
  extractedFields: Record<string, string>
): Promise<Array<Record<string, unknown>>> {
  const caseUpdateSpy = vi.fn().mockResolvedValue({ error: null });
  const client = buildMockClient(caseRow, caseUpdateSpy);
  vi.mocked(createServiceClient).mockReturnValue(client as any);

  // The worker calls extractEmailClaimMock() when shouldUseMock() = true.
  vi.mocked(extractEmailClaimMock).mockReturnValue(makeExtractedClaim(extractedFields));

  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  return caseUpdateSpy.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

function baseCaseRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: CASE_ID,
    status: "recibido",
    claim_type: "choque",
    tenant_id: TENANT_ID,
    channel: "email",
    email_thread_id: null,
    policyholder_name: null,
    policy_number: null,
    ...overrides,
  };
}

// ── AC11: full_name → policyholder_name when NULL ────────────────────────────

describe("AC11 — copy full_name to cases.policyholder_name when NULL", () => {
  it("includes policyholder_name in the case update when case field is NULL", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policyholder_name: null }),
      { full_name: "Juan Pérez", policy_number: "POL-1234" }
    );

    const update = payloads.find((p) => p.policyholder_name !== undefined);
    expect(update).toBeDefined();
    expect(update!.policyholder_name).toBe("Juan Pérez");
  });

  it("trims leading/trailing whitespace from full_name before writing", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policyholder_name: null }),
      { full_name: "  Ana García  ", policy_number: "POL-5678" }
    );

    const update = payloads.find((p) => p.policyholder_name !== undefined);
    expect(update).toBeDefined();
    expect(update!.policyholder_name).toBe("Ana García");
  });

  it("slices full_name to 200 characters when extracted value exceeds the limit", async () => {
    const longName = "A".repeat(300); // 300 chars → must be cut to 200
    const payloads = await runWorker(
      baseCaseRow({ policyholder_name: null }),
      { full_name: longName, policy_number: "POL-SHORT" }
    );

    const update = payloads.find((p) => p.policyholder_name !== undefined);
    expect(update).toBeDefined();
    expect(update!.policyholder_name).toHaveLength(200);
    expect(update!.policyholder_name).toBe("A".repeat(200));
  });
});

// ── AC12: policy_number copy when NULL ───────────────────────────────────────

describe("AC12 — copy policy_number to cases.policy_number when NULL", () => {
  it("includes policy_number in the case update when case field is NULL", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policy_number: null }),
      { full_name: "Carlos López", policy_number: "POL-12345" }
    );

    const update = payloads.find((p) => p.policy_number !== undefined);
    expect(update).toBeDefined();
    expect(update!.policy_number).toBe("POL-12345");
  });

  it("trims whitespace from policy_number before writing", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policy_number: null }),
      { full_name: "Luis Torres", policy_number: "  POL-99  " }
    );

    const update = payloads.find((p) => p.policy_number !== undefined);
    expect(update).toBeDefined();
    expect(update!.policy_number).toBe("POL-99");
  });

  it("slices policy_number to 100 characters when extracted value exceeds the limit", async () => {
    const longPolicy = "P".repeat(150); // 150 chars → must be cut to 100
    const payloads = await runWorker(
      baseCaseRow({ policy_number: null }),
      { full_name: "María Rodríguez", policy_number: longPolicy }
    );

    const update = payloads.find((p) => p.policy_number !== undefined);
    expect(update).toBeDefined();
    expect(update!.policy_number).toHaveLength(100);
    expect(update!.policy_number).toBe("P".repeat(100));
  });
});

// ── AC13: Identity guard — do NOT overwrite existing policyholder_name ────────

describe("AC13 — identity guard: do NOT overwrite already-populated policyholder_name", () => {
  it("omits policyholder_name from the update when case already has a value", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policyholder_name: "María García", policy_number: null }),
      { full_name: "Wrong Name", policy_number: "POL-9999" }
    );

    for (const payload of payloads) {
      expect(payload.policyholder_name).toBeUndefined();
    }
  });

  it("omits policyholder_name even when the AI-extracted value looks plausible", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policyholder_name: "Roberto Fernández", policy_number: null }),
      { full_name: "Roberto Fernandez", policy_number: "POL-0001" } // accent differs — still guarded
    );

    for (const payload of payloads) {
      expect(payload.policyholder_name).toBeUndefined();
    }
  });

  it("still writes policy_number when only policyholder_name is guarded", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policyholder_name: "Existing Name", policy_number: null }),
      { full_name: "Should Not Be Written", policy_number: "POL-GUARD" }
    );

    // policyholder_name must NOT appear in any payload.
    for (const payload of payloads) {
      expect(payload.policyholder_name).toBeUndefined();
    }

    // policy_number MUST appear (guard only applies to policyholder_name here).
    const update = payloads.find((p) => p.policy_number !== undefined);
    expect(update).toBeDefined();
    expect(update!.policy_number).toBe("POL-GUARD");
  });
});

// ── AC14: Empty / whitespace-only values are rejected ────────────────────────

describe("AC14 — reject empty/whitespace extracted values", () => {
  it("does NOT write policyholder_name when extracted full_name is whitespace only", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policyholder_name: null, policy_number: null }),
      { full_name: "   ", policy_number: "POL-2024" }
    );

    for (const payload of payloads) {
      expect(payload.policyholder_name).toBeUndefined();
    }
  });

  it("does NOT write policy_number when extracted value is an empty string", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policyholder_name: null, policy_number: null }),
      { full_name: "Valentina Díaz", policy_number: "" }
    );

    for (const payload of payloads) {
      expect(payload.policy_number).toBeUndefined();
    }
  });

  it("does NOT write either field when both extracted values are empty/whitespace", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policyholder_name: null, policy_number: null }),
      { full_name: "   ", policy_number: "" }
    );

    for (const payload of payloads) {
      expect(payload.policyholder_name).toBeUndefined();
      expect(payload.policy_number).toBeUndefined();
    }
  });

  it("does NOT write fields when extracted_fields has no full_name or policy_number keys", async () => {
    const payloads = await runWorker(
      baseCaseRow({ policyholder_name: null, policy_number: null }),
      { accident_date: "2024-05-01" } // neither key present
    );

    for (const payload of payloads) {
      expect(payload.policyholder_name).toBeUndefined();
      expect(payload.policy_number).toBeUndefined();
    }
  });
});
