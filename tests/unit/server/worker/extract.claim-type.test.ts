/**
 * Unit tests for claim_type persistence in runEmailExtractionWorker.
 *
 * AC1: Worker writes AI-returned claim_type to cases.claim_type and includes
 *      it in the EXTRACTION_COMPLETE audit-log payload.
 * AC2: Worker writes claim_type = 'other' without crash.
 * AC3: AI omits claim_type (null/undefined) → worker leaves cases.claim_type
 *      unchanged (claim_type NOT in caseUpdate), no throw.
 * AC4: caseRow.claim_type='choque', AI returns 'choque' → idempotent write,
 *      no crash, caseUpdate.claim_type = 'choque'.
 *
 * Extra: AI returns invalid value 'invalid_type' → claim_type NOT written,
 *        a warn is logged, no throw.
 *
 * Strategy: use vi.resetModules() + vi.doMock() per test so each test gets
 * an isolated module registry. The worker is imported AFTER mocks are set,
 * preventing cross-test state leakage (same pattern used by extractor-ac6-happy-path.test.ts).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const CASE_ID   = "claimtype-test-0000-0000-000000000001";
const TENANT_ID = "claimtype-test-0000-0000-000000000002";

// ── Shared mock helpers ───────────────────────────────────────────────────────

/** Build a minimal mock case row representing a real email case. */
function makeCaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    status: "recibido",
    claim_type: null as string | null,
    tenant_id: TENANT_ID,
    channel: "email",
    email_thread_id: "thread-001",
    policyholder_name: null,
    policy_number: null,
    ...overrides,
  };
}

/**
 * Build a mock Supabase service client that:
 *  - Returns `caseRow` from cases.select().eq().eq().single()
 *  - Records cases.update() calls via `caseUpdateSpy`
 *  - Returns a raw_messages row so the worker proceeds past the message fetch
 *  - Returns empty/null results for all other tables
 *
 * @param caseRow      - The case row to return from DB
 * @param caseUpdateSpy - Spy to capture the update payload(s)
 */
function buildMockSupabase(
  caseRow: ReturnType<typeof makeCaseRow>,
  caseUpdateSpy: ReturnType<typeof vi.fn>
) {
  return {
    from: (table: string) => {
      if (table === "cases") {
        return {
          select: (_cols: string) => ({
            eq: (_c: string, _v: string) => ({
              eq: (_c2: string, _v2: string) => ({
                single: () => Promise.resolve({ data: caseRow, error: null }),
              }),
            }),
          }),
          update: (data: unknown) => ({
            eq: (_c: string, _v: string) => {
              caseUpdateSpy(data);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }

      if (table === "raw_messages") {
        return {
          select: (_cols: string) => ({
            eq: (_c: string, _v: string) => ({
              order: (_col: string, _opts: unknown) => ({
                limit: (_n: number) => ({
                  single: () =>
                    Promise.resolve({
                      data: {
                        body: "Tuve un accidente.",
                        subject: "Siniestro",
                        from_addr: "claimant@example.com",
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      }

      // All other tables return empty / no-op responses.
      return {
        select: (_cols: string) => ({
          eq: (_c: string, _v: unknown) => ({
            eq: (_c2: string, _v2: unknown) => ({
              order: (_col: string, _opts: unknown) => ({
                limit: (_n: number) => Promise.resolve({ data: [], error: null }),
              }),
              single: () => Promise.resolve({ data: null, error: null }),
            }),
            order: (_col: string, _opts: unknown) => ({
              limit: (_n: number) => Promise.resolve({ data: [], error: null }),
            }),
            limit: (_n: number) => Promise.resolve({ data: [], error: null }),
            or: (_expr: string) => ({
              eq: (_c3: string, _v3: unknown) => ({
                limit: (_n: number) => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
          or: (_expr: string) => ({
            eq: (_c2: string, _v2: unknown) => ({
              limit: (_n: number) => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
        upsert: (_data: unknown, _opts?: unknown) => Promise.resolve({ error: null }),
        update: (_data: unknown) => ({
          eq: (_c: string, _v: unknown) => Promise.resolve({ error: null }),
        }),
        insert: (_data: unknown) => Promise.resolve({ error: null }),
      };
    },
  };
}

// ── Common module mocks applied in every test via vi.doMock ───────────────────

/** Register all mocks needed for the email extraction worker to run without error. */
function registerCommonMocks(
  caseRow: ReturnType<typeof makeCaseRow>,
  caseUpdateSpy: ReturnType<typeof vi.fn>,
  auditLogSpy: ReturnType<typeof vi.fn>,
  claimMockOverrides: Record<string, unknown> = {}
) {
  const supabase = buildMockSupabase(caseRow, caseUpdateSpy);

  vi.doMock("@/lib/supabase/service", () => ({
    createServiceClient: () => supabase,
  }));

  vi.doMock("@/lib/audit/log", () => ({
    writeAuditLog: auditLogSpy,
    AuditEvent: {
      EXTRACTION_COMPLETE:  "claim.extraction_complete",
      SPECIALIST_REQUIRED:  "claim.specialist_required",
      MEMORY_APPLIED:       "claim.memory_applied",
      AI_BUDGET_EXCEEDED:   "ai.budget_exceeded",
      AI_EXTRACTED:         "ai.extracted",
    },
  }));

  vi.doMock("@/server/ai/budget", () => ({
    checkBudget:  vi.fn().mockResolvedValue({ exceeded: false }),
    recordUsage:  vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("@/server/matching/customer-matcher", () => ({
    findCustomerMatches: vi.fn().mockResolvedValue([]),
  }));

  vi.doMock("@/server/matching/policy-matcher", () => ({
    findPolicyMatches: vi.fn().mockResolvedValue([]),
  }));

  vi.doMock("@/server/confirmations/orchestrate", () => ({
    orchestratePostExtraction: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("@/server/ai/severity-classifier", () => ({
    classifySeverity:    vi.fn().mockReturnValue("medium"),
    requiresSpecialist:  vi.fn().mockReturnValue(false),
  }));

  vi.doMock("@/server/cases/fsm", () => ({
    isValidTransition: vi.fn().mockReturnValue(true),
  }));

  // Mock extractEmailClaimMock to return whatever the test specifies via overrides.
  vi.doMock("@/server/ai/mock-extractor", () => ({
    runMockExtractor:      vi.fn(),
    extractEmailClaimMock: vi.fn().mockReturnValue({
      extraction_model: "mock-email-v1",
      fields: [
        { field_key: "full_name",    field_value: "Juan Pérez", confidence: 0.92, source: "ai" },
        { field_key: "claim_type",   field_value: "choque",     confidence: 0.88, source: "ai" },
      ],
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      is_claim: true,
      confidence: 0.92,
      extracted_fields: {
        full_name: "Juan Pérez",
        claim_type: "choque",
        ...claimMockOverrides,
      },
      field_confidences: { claim_type: 0.88 },
      missing_fields: [],
      fields_pending_confirmation: [],
      possible_customer_matches: [],
      possible_policy_matches: [],
      severity: "medium",
      requires_specialist: false,
      not_relevant_reason: undefined,
      summary: "",
      suggested_reply: "",
    }),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe("runEmailExtractionWorker — claim_type persistence", () => {
  it(
    "AC1: AI returns claim_type='robo' → caseUpdate.claim_type='robo' and audit log includes claim_type",
    async () => {
      vi.resetModules();

      const caseUpdateSpy = vi.fn().mockResolvedValue({ error: null });
      const auditLogSpy   = vi.fn().mockResolvedValue(undefined);
      const caseRow = makeCaseRow({ claim_type: null });

      registerCommonMocks(caseRow, caseUpdateSpy, auditLogSpy);

      // Override the mock to return "robo" as claim_type.
      vi.doMock("@/server/ai/mock-extractor", () => ({
        runMockExtractor:      vi.fn(),
        extractEmailClaimMock: vi.fn().mockReturnValue({
          extraction_model: "mock-email-v1",
          fields: [
            { field_key: "claim_type", field_value: "robo", confidence: 0.90, source: "ai" },
          ],
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          is_claim: true,
          confidence: 0.92,
          extracted_fields: { claim_type: "robo" },
          field_confidences: { claim_type: 0.90 },
          missing_fields: [],
          fields_pending_confirmation: [],
          possible_customer_matches: [],
          possible_policy_matches: [],
          severity: "medium",
          requires_specialist: false,
          not_relevant_reason: undefined,
          summary: "",
          suggested_reply: "",
        }),
      }));

      const { runEmailExtractionWorker } = await import("@/server/worker/extract");
      await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

      // caseUpdate must include claim_type = "robo"
      const allUpdatePayloads = caseUpdateSpy.mock.calls.map((c) => c[0]);
      const claimTypeWrite = allUpdatePayloads.find(
        (p: Record<string, unknown>) => p.claim_type !== undefined
      );
      expect(claimTypeWrite).toBeDefined();
      expect(claimTypeWrite!.claim_type).toBe("robo");

      // Audit log (EXTRACTION_COMPLETE) must include claim_type = "robo"
      const extractionCompleteCall = auditLogSpy.mock.calls.find(
        (c: any[]) => c[0]?.event_type === "claim.extraction_complete"
      );
      expect(extractionCompleteCall).toBeDefined();
      expect(extractionCompleteCall![0].payload.claim_type).toBe("robo");
    },
    30_000
  );

  it(
    "AC2: AI returns claim_type='other' → caseUpdate.claim_type='other', no crash",
    async () => {
      vi.resetModules();

      const caseUpdateSpy = vi.fn().mockResolvedValue({ error: null });
      const auditLogSpy   = vi.fn().mockResolvedValue(undefined);
      const caseRow = makeCaseRow({ claim_type: null });

      registerCommonMocks(caseRow, caseUpdateSpy, auditLogSpy);

      vi.doMock("@/server/ai/mock-extractor", () => ({
        runMockExtractor:      vi.fn(),
        extractEmailClaimMock: vi.fn().mockReturnValue({
          extraction_model: "mock-email-v1",
          fields: [
            { field_key: "claim_type", field_value: "other", confidence: 0.80, source: "ai" },
          ],
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          is_claim: true,
          confidence: 0.80,
          extracted_fields: { claim_type: "other" },
          field_confidences: { claim_type: 0.80 },
          missing_fields: [],
          fields_pending_confirmation: [],
          possible_customer_matches: [],
          possible_policy_matches: [],
          severity: "medium",
          requires_specialist: false,
          not_relevant_reason: undefined,
          summary: "",
          suggested_reply: "",
        }),
      }));

      const { runEmailExtractionWorker } = await import("@/server/worker/extract");

      // Must not throw
      await expect(
        runEmailExtractionWorker(CASE_ID, TENANT_ID, null)
      ).resolves.toBeUndefined();

      const allUpdatePayloads = caseUpdateSpy.mock.calls.map((c) => c[0]);
      const claimTypeWrite = allUpdatePayloads.find(
        (p: Record<string, unknown>) => p.claim_type !== undefined
      );
      expect(claimTypeWrite).toBeDefined();
      expect(claimTypeWrite!.claim_type).toBe("other");
    },
    30_000
  );

  it(
    "AC3: AI omits claim_type (null in extracted_fields, no claim_type in fields array) → caseUpdate does NOT include claim_type",
    async () => {
      vi.resetModules();

      const caseUpdateSpy = vi.fn().mockResolvedValue({ error: null });
      const auditLogSpy   = vi.fn().mockResolvedValue(undefined);
      const caseRow = makeCaseRow({ claim_type: "choque" });  // existing value

      registerCommonMocks(caseRow, caseUpdateSpy, auditLogSpy);

      vi.doMock("@/server/ai/mock-extractor", () => ({
        runMockExtractor:      vi.fn(),
        extractEmailClaimMock: vi.fn().mockReturnValue({
          extraction_model: "mock-email-v1",
          fields: [
            // No claim_type field in the fields array
            { field_key: "full_name", field_value: "María García", confidence: 0.90, source: "ai" },
          ],
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          is_claim: true,
          confidence: 0.90,
          extracted_fields: {
            full_name: "María García",
            // claim_type is absent — not even present in the object
          },
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
        }),
      }));

      const { runEmailExtractionWorker } = await import("@/server/worker/extract");

      // Must not throw
      await expect(
        runEmailExtractionWorker(CASE_ID, TENANT_ID, null)
      ).resolves.toBeUndefined();

      // claim_type must NOT appear in any cases.update() call
      const allUpdatePayloads = caseUpdateSpy.mock.calls.map((c) => c[0]);
      const claimTypeWrite = allUpdatePayloads.find(
        (p: Record<string, unknown>) => "claim_type" in p
      );
      expect(claimTypeWrite).toBeUndefined();
    },
    30_000
  );

  it(
    "AC4: existing cases.claim_type='choque', AI returns 'choque' → idempotent write, caseUpdate.claim_type='choque'",
    async () => {
      vi.resetModules();

      const caseUpdateSpy = vi.fn().mockResolvedValue({ error: null });
      const auditLogSpy   = vi.fn().mockResolvedValue(undefined);
      // The case already has claim_type='choque' in the DB.
      const caseRow = makeCaseRow({ claim_type: "choque" });

      registerCommonMocks(caseRow, caseUpdateSpy, auditLogSpy);

      vi.doMock("@/server/ai/mock-extractor", () => ({
        runMockExtractor:      vi.fn(),
        extractEmailClaimMock: vi.fn().mockReturnValue({
          extraction_model: "mock-email-v1",
          fields: [
            { field_key: "claim_type", field_value: "choque", confidence: 0.88, source: "ai" },
          ],
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          is_claim: true,
          confidence: 0.88,
          extracted_fields: { claim_type: "choque" },
          field_confidences: { claim_type: 0.88 },
          missing_fields: [],
          fields_pending_confirmation: [],
          possible_customer_matches: [],
          possible_policy_matches: [],
          severity: "medium",
          requires_specialist: false,
          not_relevant_reason: undefined,
          summary: "",
          suggested_reply: "",
        }),
      }));

      const { runEmailExtractionWorker } = await import("@/server/worker/extract");
      await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

      // Must still write claim_type even when the same value (idempotent)
      const allUpdatePayloads = caseUpdateSpy.mock.calls.map((c) => c[0]);
      const claimTypeWrite = allUpdatePayloads.find(
        (p: Record<string, unknown>) => p.claim_type !== undefined
      );
      expect(claimTypeWrite).toBeDefined();
      expect(claimTypeWrite!.claim_type).toBe("choque");
    },
    30_000
  );

  it(
    "Extra: AI returns invalid claim_type='invalid_type' → claim_type NOT written, warning logged, no crash",
    async () => {
      vi.resetModules();

      const caseUpdateSpy = vi.fn().mockResolvedValue({ error: null });
      const auditLogSpy   = vi.fn().mockResolvedValue(undefined);
      const warnSpy       = vi.spyOn(console, "warn").mockImplementation(() => {});
      const caseRow = makeCaseRow({ claim_type: null });

      registerCommonMocks(caseRow, caseUpdateSpy, auditLogSpy);

      vi.doMock("@/server/ai/mock-extractor", () => ({
        runMockExtractor:      vi.fn(),
        extractEmailClaimMock: vi.fn().mockReturnValue({
          extraction_model: "mock-email-v1",
          fields: [
            { field_key: "claim_type", field_value: "invalid_type", confidence: 0.50, source: "ai" },
          ],
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          is_claim: true,
          confidence: 0.70,
          extracted_fields: { claim_type: "invalid_type" },
          field_confidences: { claim_type: 0.50 },
          missing_fields: [],
          fields_pending_confirmation: [],
          possible_customer_matches: [],
          possible_policy_matches: [],
          severity: "medium",
          requires_specialist: false,
          not_relevant_reason: undefined,
          summary: "",
          suggested_reply: "",
        }),
      }));

      const { runEmailExtractionWorker } = await import("@/server/worker/extract");

      // Must not throw
      await expect(
        runEmailExtractionWorker(CASE_ID, TENANT_ID, null)
      ).resolves.toBeUndefined();

      // claim_type must NOT appear in any cases.update() call
      const allUpdatePayloads = caseUpdateSpy.mock.calls.map((c) => c[0]);
      const claimTypeWrite = allUpdatePayloads.find(
        (p: Record<string, unknown>) => "claim_type" in p
      );
      expect(claimTypeWrite).toBeUndefined();

      // A warning must have been logged
      const warnCall = warnSpy.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("claim_type_invalid")
      );
      expect(warnCall).toBeDefined();

      warnSpy.mockRestore();
    },
    30_000
  );
});
