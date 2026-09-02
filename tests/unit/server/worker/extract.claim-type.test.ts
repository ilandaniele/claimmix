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
 * preventing cross-test state leakage.
 */

import { describe, it, expect, vi, afterEach , type Mock } from "vitest";

import { filaDeCaso, registrarMocks } from "./worker-harness";

const CASE_ID   = "claimtype-test-0000-0000-000000000001";
const TENANT_ID = "claimtype-test-0000-0000-000000000002";

// ── Shared mock helpers ───────────────────────────────────────────────────────

/*
 * El andamiaje sale de `worker-harness.ts`, compartido con los otros archivos
 * de test del worker. Acá estaba escrito entero: la fila del caso, el `db`
 * simulado y los dieciocho `vi.doMock`, más de cien líneas.
 *
 * Este archivo usa el estilo de `vi.doMock` por test con `resetModules`, que es
 * el que el harness implementa; los tres `extract.email.*` usan `vi.mock` a
 * nivel de archivo y comparten otro módulo, `db-simulado.ts`. Son dos estilos
 * distintos a propósito y no se pueden unificar: `vi.mock` se iza.
 */
function makeCaseRow(overrides: Record<string, unknown> = {}) {
  return filaDeCaso(CASE_ID, TENANT_ID, overrides as never);
}

function registerCommonMocks(
  caseRow: ReturnType<typeof makeCaseRow>,
  caseUpdateSpy: Mock<(data: Record<string, unknown>) => void>,
  auditLogSpy: Mock<(...args: never[]) => unknown>,
  claimMockOverrides: Record<string, unknown> = {}
) {
  registrarMocks({
    fila: caseRow,
    espiaDeUpdate: caseUpdateSpy,
    espiaDeAuditoria: auditLogSpy,
    extractor: {
      extracted_fields_extra: claimMockOverrides as Record<string, string | undefined>,
    },
  });
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

      const caseUpdateSpy = vi.fn<(data: Record<string, unknown>) => void>();
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

      const caseUpdateSpy = vi.fn<(data: Record<string, unknown>) => void>();
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

      const caseUpdateSpy = vi.fn<(data: Record<string, unknown>) => void>();
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

      const caseUpdateSpy = vi.fn<(data: Record<string, unknown>) => void>();
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

      const caseUpdateSpy = vi.fn<(data: Record<string, unknown>) => void>();
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
          confidence: 0.50,
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

      // claim_type must NOT appear in any update call
      const allUpdatePayloads = caseUpdateSpy.mock.calls.map((c) => c[0]);
      const claimTypeWrite = allUpdatePayloads.find(
        (p: Record<string, unknown>) => "claim_type" in p
      );
      expect(claimTypeWrite).toBeUndefined();

      warnSpy.mockRestore();
    },
    30_000
  );
});
