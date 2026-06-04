/**
 * Unit tests for AC6 happy path — high-confidence extraction matches
 * existing customer and policy.
 *
 * AC6: High-confidence extraction matches existing customer and policy —
 *      sets cases.customer_id, cases.policy_id; status=recibido or
 *      listo_para_core; no data_confirmation_request email sent.
 *
 * Strategy: test orchestratePostExtraction directly with a mock Supabase
 * client that includes customerMatch data. Because customer_id and policy_id
 * are set by runEmailExtractionWorker (not orchestrate), we verify that
 * side by checking the worker's case update call.
 *
 * For AC6 orchestration (no confirmation email when matched), we verify:
 *   - No data_confirmation_request is dispatched.
 *   - No claim_field_confirmations row is created for matched fields.
 *   - Status transitions to 'recibido' (or 'listo_para_core') — not
 *     'confirmacion_pendiente'.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CustomerMatch } from "@/server/matching/customer-matcher";
import { extractEmailClaimMock } from "@/server/ai/mock-extractor";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/server/email/dispatch", () => ({
  dispatchOutboundEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    SPECIALIST_REQUIRED: "claim.specialist_required",
    CONFIRMATION_REQUESTED: "claim.confirmation_requested",
    MISSING_INFO_REQUESTED: "claim.missing_info_requested",
    OUTBOUND_EMAIL_SENT: "email.outbound_sent",
    OUTBOUND_EMAIL_FAILED: "email.outbound_failed",
    EXTRACTION_COMPLETE: "claim.extraction_complete",
  },
}));

// Gap analyzer — for AC6 high-confidence match, claim is complete.
vi.mock("@/server/cases/gap-analyzer", () => ({
  analyzeEmailClaimGaps: vi.fn().mockResolvedValue({
    missingRequiredFields: [],
    fieldsNeedingConfirmation: [],
    isComplete: true,
    status: "listo_para_core",
  }),
}));

// ── Import mocked modules for assertion ──────────────────────────────────────

import { dispatchOutboundEmail } from "@/server/email/dispatch";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";
import { orchestratePostExtraction } from "@/server/confirmations/orchestrate";

// ── Mock Supabase factory ─────────────────────────────────────────────────────

function buildMockSupabase({
  outboundMessagesRows = [] as any[],
  caseUpdateSpy = vi.fn().mockResolvedValue({ error: null }),
  confirmationUpsertSpy = vi.fn().mockResolvedValue({ error: null }),
} = {}) {
  return {
    from: (table: string) => {
      if (table === "cases") {
        return {
          update: (data: any) => ({
            eq: (col: string, val: string) => caseUpdateSpy(data, col, val),
          }),
        };
      }
      if (table === "claim_field_confirmations") {
        return {
          upsert: (data: any, opts: any) => confirmationUpsertSpy(data, opts),
        };
      }
      if (table === "outbound_messages") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () =>
                  Promise.resolve({ data: outboundMessagesRows, error: null }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
            is: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
        upsert: () => Promise.resolve({ error: null }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
    _caseUpdateSpy: caseUpdateSpy,
    _confirmationUpsertSpy: confirmationUpsertSpy,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASE_ID   = "ac6test-0000-0000-0000-000000000001";
const TENANT_ID = "ac6test-0000-0000-0000-000000000002";
const SENDER_EMAIL = "claimant@example.com";

const HIGH_CONFIDENCE_MATCH: CustomerMatch = {
  customerId: "customer-uuid-001",
  policyId:   "policy-uuid-001",
  matchType:  "policy_number",
  confidence: 0.95,            // policy_number match = highest confidence
  customerName: "Juan Pérez",
  conflictsWithExtracted: [],  // no conflicts — clean match
};

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default gap analysis result: complete claim (no missing fields, no pending confirmations).
  vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
    missingRequiredFields: [],
    fieldsNeedingConfirmation: [],
    isComplete: true,
    status: "listo_para_core",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test suite: AC6 happy path ────────────────────────────────────────────────

describe("AC6 — high-confidence extraction: customer + policy matched, no confirmation email", () => {
  it(
    "does NOT dispatch data_confirmation_request when customer and policy are matched at high confidence",
    async () => {
      // Extracted claim: policy_number at 0.90 confidence (high).
      const claim = extractEmailClaimMock({
        fields: [
          { field_key: "full_name",     field_value: "Juan Pérez",   confidence: 0.92, source: "ai" as const },
          { field_key: "email",         field_value: "juan@example.com", confidence: 0.95, source: "ai" as const },
          { field_key: "policy_number", field_value: "POL-1234",     confidence: 0.90, source: "ai" as const },
          { field_key: "accident_date", field_value: "2024-03-15",   confidence: 0.90, source: "ai" as const },
        ],
        // No pending confirmation fields — all high confidence.
        fields_pending_confirmation: [],
      });

      const supabase = buildMockSupabase({ outboundMessagesRows: [] });

      await orchestratePostExtraction(
        supabase as any,
        CASE_ID,
        TENANT_ID,
        { extractedClaim: claim, senderEmail: SENDER_EMAIL },
        [HIGH_CONFIDENCE_MATCH]  // single high-confidence match, no conflicts
      );

      // No data_confirmation_request must be dispatched (AC6 guarantee).
      const confirmationEmailCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
        (call) => call[0].template === "data_confirmation_request"
      );
      expect(confirmationEmailCall).toBeUndefined();
    }
  );

  it(
    "does NOT create a claim_field_confirmations row for matched fields (no pending confirmations)",
    async () => {
      const claim = extractEmailClaimMock({
        fields_pending_confirmation: [],  // all fields matched at high confidence
      });

      const confirmationUpsertSpy = vi.fn().mockResolvedValue({ error: null });
      const supabase = buildMockSupabase({
        confirmationUpsertSpy,
        outboundMessagesRows: [],
      });

      await orchestratePostExtraction(
        supabase as any,
        CASE_ID,
        TENANT_ID,
        { extractedClaim: claim, senderEmail: SENDER_EMAIL },
        [HIGH_CONFIDENCE_MATCH]  // matched, no conflicts
      );

      // No claim_field_confirmations upsert should be called.
      expect(confirmationUpsertSpy).not.toHaveBeenCalled();
    }
  );

  it(
    "transitions status to listo_para_core (not confirmacion_pendiente) for complete high-confidence match",
    async () => {
      const claim = extractEmailClaimMock({
        fields_pending_confirmation: [],
      });

      const caseUpdateSpy = vi.fn().mockResolvedValue({ error: null });
      const supabase = buildMockSupabase({
        caseUpdateSpy,
        outboundMessagesRows: [],
      });

      // Gap analyzer confirms claim is complete.
      vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
        missingRequiredFields: [],
        fieldsNeedingConfirmation: [],
        isComplete: true,
        status: "listo_para_core",
      });

      await orchestratePostExtraction(
        supabase as any,
        CASE_ID,
        TENANT_ID,
        { extractedClaim: claim, senderEmail: SENDER_EMAIL },
        [HIGH_CONFIDENCE_MATCH]
      );

      // Status must be listo_para_core or recibido — NOT confirmacion_pendiente.
      const confirmacionPendienteUpdate = caseUpdateSpy.mock.calls.find(
        (call) => call[0]?.status === "confirmacion_pendiente"
      );
      expect(confirmacionPendienteUpdate).toBeUndefined();

      const listoCoreUpdate = caseUpdateSpy.mock.calls.find(
        (call) => call[0]?.status === "listo_para_core"
      );
      // At least one status update must be to listo_para_core.
      expect(listoCoreUpdate).toBeDefined();
    }
  );

  it(
    "still dispatches confirmation_received (AC12) even for high-confidence matched case",
    async () => {
      const claim = extractEmailClaimMock({
        fields_pending_confirmation: [],
      });

      const supabase = buildMockSupabase({ outboundMessagesRows: [] });

      await orchestratePostExtraction(
        supabase as any,
        CASE_ID,
        TENANT_ID,
        { extractedClaim: claim, senderEmail: SENDER_EMAIL },
        [HIGH_CONFIDENCE_MATCH]
      );

      // confirmation_received MUST always be dispatched for is_claim=true (AC12).
      const confirmationReceived = vi.mocked(dispatchOutboundEmail).mock.calls.find(
        (call) => call[0].template === "confirmation_received"
      );
      expect(confirmationReceived).toBeDefined();
      expect(confirmationReceived?.[0].caseId).toBe(CASE_ID);
      expect(confirmationReceived?.[0].to).toBe(SENDER_EMAIL);
    }
  );
});

// ── Worker-level AC6 test: customer_id and policy_id are written to the case ──
// This test exercises the runEmailExtractionWorker at the unit level
// by mocking the DB and verifying the case update payload includes both IDs.

describe("AC6 — worker: customer_id and policy_id set on case update", () => {
  it(
    "sets customer_id and policy_id on the case when high-confidence match is found",
    async () => {
      // Build the case update spy before mocking the service client.
      const caseUpdateSpy = vi.fn().mockResolvedValue({ error: null });

      // Reset module registry so the dynamic import below gets a fresh load
      // that sees our vi.doMock replacements. Without this, a cached module
      // from another test file is returned and vi.doMock has no effect.
      vi.resetModules();

      // Mock the service client used by the worker.
      vi.doMock("@/lib/supabase/service", () => ({
        createServiceClient: () => ({
          from: (table: string) => {
            if (table === "cases") {
              return {
                // First call: .select().eq().eq().single() — fetch case row.
                select: (_cols: string) => ({
                  eq: (_c: string, _v: string) => ({
                    eq: (_c2: string, _v2: string) => ({
                      single: () =>
                        Promise.resolve({
                          data: {
                            id: CASE_ID,
                            status: "recibido",
                            claim_type: "choque",
                            tenant_id: TENANT_ID,
                            channel: "email",
                            email_thread_id: "thread-001",
                          },
                          error: null,
                        }),
                    }),
                  }),
                }),
                // Update call: verify customer_id + policy_id are in the payload.
                update: (data: any) => ({
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
                    order: (_col: string, _opts: any) => ({
                      limit: (_n: number) => ({
                        single: () =>
                          Promise.resolve({
                            data: {
                              body: "Tuve un choque. Poliza: POL-1234.",
                              subject: "Siniestro",
                              from_addr: SENDER_EMAIL,
                            },
                            error: null,
                          }),
                      }),
                    }),
                  }),
                }),
              };
            }
            // All other tables return empty results.
            return {
              select: (_cols: string) => ({
                eq: (_c: string, _v: string) => ({
                  eq: (_c2: string, _v2: string) => ({
                    order: (_col: string, _opts: any) => ({
                      limit: (_n: number) => Promise.resolve({ data: [], error: null }),
                    }),
                    single: () => Promise.resolve({ data: null, error: null }),
                  }),
                  order: (_col: string, _opts: any) => ({
                    limit: (_n: number) => Promise.resolve({ data: [], error: null }),
                  }),
                  limit: (_n: number) => Promise.resolve({ data: [], error: null }),
                }),
              }),
              upsert: (_data: any, _opts: any) => Promise.resolve({ error: null }),
              update: (_data: any) => ({
                eq: (_c: string, _v: string) => Promise.resolve({ error: null }),
              }),
              insert: (_data: any) => Promise.resolve({ error: null }),
            };
          },
        }),
      }));

      // Mock customer matcher to return a single high-confidence match.
      vi.doMock("@/server/matching/customer-matcher", () => ({
        findCustomerMatches: vi.fn().mockResolvedValue([HIGH_CONFIDENCE_MATCH]),
      }));

      // Mock policy matcher to return a policy match.
      vi.doMock("@/server/matching/policy-matcher", () => ({
        findPolicyMatches: vi.fn().mockResolvedValue([
          { policyId: "policy-uuid-001", matchType: "exact", confidence: 0.95 },
        ]),
      }));

      // Mock the budget check to pass.
      vi.doMock("@/server/ai/budget", () => ({
        checkBudget: vi.fn().mockResolvedValue({ exceeded: false }),
        recordUsage: vi.fn().mockResolvedValue(undefined),
      }));

      // Mock orchestratePostExtraction to avoid its DB calls in this test.
      vi.doMock("@/server/confirmations/orchestrate", () => ({
        orchestratePostExtraction: vi.fn().mockResolvedValue(undefined),
      }));

      // Import the worker AFTER setting up all mocks.
      const { runEmailExtractionWorker } = await import(
        "@/server/worker/extract"
      );
      await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

      // Verify that the case update included customer_id and policy_id.
      const updateCalls = caseUpdateSpy.mock.calls;
      const caseUpdatePayload = updateCalls.find(
        (call: any[]) =>
          call[0]?.customer_id !== undefined || call[0]?.policy_id !== undefined
      );

      expect(caseUpdatePayload).toBeDefined();
      expect(caseUpdatePayload![0].customer_id).toBe("customer-uuid-001");
      expect(caseUpdatePayload![0].policy_id).toBe("policy-uuid-001");
    },
    30_000 // vi.resetModules() + dynamic import can be slow in the full suite
  );
});
