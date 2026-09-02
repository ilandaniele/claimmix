/**
 * AC6, del lado del worker: que el cliente y la póliza encontrados queden
 * escritos en el caso.
 *
 * ── Lo que este archivo dejó de tener, y por qué ────────────────────────────
 *
 * Tenía además cuatro tests sobre `orchestratePostExtraction` que no probaban
 * NADA: el archivo mockea `@/server/confirmations/orchestrate` acá abajo, y
 * después importaba esa función y la llamaba — o sea, llamaba al mock. Los tres
 * «no manda nada» pasaban porque una función vacía no manda nada, y el cuarto
 * afirmaba que el mock había sido llamado con los argumentos que el propio test
 * le acababa de pasar.
 *
 * Cuatro criterios de aceptación en verde sin ejecutar una línea del código que
 * decían cubrir. Se mudaron a `orchestrate-post-extraction.test.ts`, que es
 * donde esa función corre de verdad, y ahí afirman lo que tienen que afirmar:
 * el estado que SÍ queda, y no sólo el que no.
 *
 * El mock se queda porque lo que se prueba acá es el worker, y para eso
 * orquestar de verdad sería ruido.
 */

// vi.mock() calls are hoisted to the top of the file by Vitest.

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Las funciones migradas piden enTenant(ctx, (db) => consulta) en vez de
// hablar con db directamente. Lo que estos tests verifican —qué tabla, qué
// filtros de negocio, qué columnas— no cambió, así que alcanza con que la
// capa les entregue el db simulado.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso no se puede simular sin mentir. Se verifica en
// tests/unit/data-scope-sin-rol.test.ts y, contra bases de verdad, en
// `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  // Se lee `mod.db` en CADA llamada, sin desestructurar.
  //
  // El mock de @/lib/db expone `db` con un getter para que los tests puedan
  // intercambiar la base simulada entre corridas. Un `const { db } = ...`
  // llama al getter una sola vez y congela ese valor: al cambiar la base, el
  // puente seguía entregando la anterior y el caso aparecía como inexistente.
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    $count: vi.fn(),
  },
  tables: {},
}));

vi.mock("@/lib/db/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/helpers")>();
  return { ...actual, firstRow: actual.firstRow };
});

vi.mock("@/server/email/dispatch", () => ({
  dispatchOutboundEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    AI_EXTRACTED: "claim.ai_extracted",
    AI_BUDGET_EXCEEDED: "claim.budget_exceeded",
    SPECIALIST_REQUIRED: "claim.specialist_required",
    CONFIRMATION_REQUESTED: "claim.confirmation_requested",
    MISSING_INFO_REQUESTED: "claim.missing_info_requested",
    OUTBOUND_EMAIL_SENT: "email.outbound_sent",
    OUTBOUND_EMAIL_FAILED: "email.outbound_failed",
    EXTRACTION_COMPLETE: "claim.extraction_complete",
    MEMORY_APPLIED: "claim.memory_applied",
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

// Worker dependencies
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

vi.mock("@/core/case/fsm", () => ({
  isValidTransition: vi.fn().mockReturnValue(true),
}));

vi.mock("@/core/case/gap-analysis", () => ({
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

vi.mock("@/server/ai/mock-extractor", () => ({
  extractEmailClaimMock: vi.fn(),
  runMockExtractor: vi.fn(),
}));

vi.mock("@/server/ai/gemini-extractor", () => ({
  extractEmailClaimGemini: vi.fn(),
  runGeminiExtractor: vi.fn(),
  GeminiExtractionError: class GeminiExtractionError extends Error {},
}));

vi.mock("@/server/ai/provider", () => ({
  resolveExtractionEngine: vi.fn().mockResolvedValue("mock"),
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
  getActivePromptVersion: vi.fn().mockResolvedValue({
    id: null,
    version: "builtin-v1",
    systemPrompt: null,
  }),
}));

vi.mock("@/server/training/trainability", () => ({
  assessTrainability: vi.fn().mockReturnValue({ should_train: false }),
}));

vi.mock("@/server/training/agent-runs", () => ({
  logAgentRun: vi.fn().mockResolvedValue(undefined),
  logAgentRunError: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/server/memory/load", () => ({
  loadMemoryHints: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/server/ai/hydrate-fields", () => ({
  hydrateFieldsFromExtracted: vi.fn().mockReturnValue([]),
  scrubPiiFromSummary: vi.fn().mockImplementation((claim: any) => claim),
}));

vi.mock("@/lib/email/claim-parser", () => ({
  mergeExtractedFields: vi.fn().mockImplementation((hydrated: any[], _fallback: any[]) => hydrated),
  parseEmailClaimFields: vi.fn().mockReturnValue([]),
}));

// ── Import mocked modules for assertion ──────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CustomerMatch } from "@/server/matching/customer-matcher";
import { dispatchOutboundEmail } from "@/server/email/dispatch";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";
import { orchestratePostExtraction } from "@/server/confirmations/orchestrate";
import { findCustomerMatches } from "@/server/matching/customer-matcher";
import { findPolicyMatches } from "@/server/matching/policy-matcher";
import { extractEmailClaimMock } from "@/server/ai/mock-extractor";
import { runEmailExtractionWorker } from "@/server/worker/extract";
import { db } from "@/lib/db";
import { extraccion } from "../helpers/extraccion";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASE_ID   = "ac6test-0000-0000-0000-000000000001";
const TENANT_ID = "ac6test-0000-0000-0000-000000000002";
const SENDER_EMAIL = "claimant@example.com";

const HIGH_CONFIDENCE_MATCH: CustomerMatch = {
  customerId: "customer-uuid-001",
  policyId:   "policy-uuid-001",
  storedValues: {},
  matchType:  "policy_number",
  confidence: 0.95,
  customerName: "Juan Pérez",
  conflictsWithExtracted: [],
};

// ── DB mock helpers ──────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[]): any {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

function makeUpdateChain(spy?: (payload: Record<string, unknown>) => void): any {
  return {
    set: (payload: Record<string, unknown>) => ({
      where: (..._args: any[]) => {
        spy?.(payload);
        return Promise.resolve([]);
      },
    }),
  };
}

function makeInsertChain(): any {
  const valuesResult: any = {
    onConflictDoUpdate: vi.fn().mockResolvedValue([]),
    then: (resolve: (v: any) => void) => Promise.resolve([]).then(resolve),
    catch: (onRejected: (e: any) => void) => Promise.resolve([]).catch(onRejected),
  };
  return {
    values: vi.fn().mockReturnValue(valuesResult),
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
    missingRequiredFields: [],
    fieldsNeedingConfirmation: [],
    isComplete: true,
    status: "listo_para_core",
  });

  vi.mocked(db.select).mockReturnValue(makeSelectChain([]));
  vi.mocked(db.update).mockReturnValue(makeUpdateChain() as any);
  vi.mocked(db.insert).mockReturnValue(makeInsertChain() as any);

  vi.mocked(orchestratePostExtraction).mockResolvedValue(undefined);
  vi.mocked(findCustomerMatches).mockResolvedValue([]);
  vi.mocked(findPolicyMatches).mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Worker-level AC6 test: customer_id and policy_id are written to the case ──
// This test exercises the runEmailExtractionWorker at the unit level
// by mocking the DB and verifying the case update payload includes both IDs.

describe("AC6 — worker: customer_id and policy_id set on case update", () => {
  it(
    "sets customer_id and policy_id on the case when high-confidence match is found",
    async () => {
      const caseRow = {
        id: CASE_ID,
        status: "recibido",
        claim_type: "choque",
        tenant_id: TENANT_ID,
        channel: "email",
        email_thread_id: "thread-001",
        policyholder_name: null,
        policy_number: null,
      };

      const caseUpdateSpy = vi.fn();

      // db.select: return appropriate data per call order
      // 1: cases row, 2: raw_messages, 3+: everything else empty
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const call = selectCallCount;

        if (call === 1) {
          return makeSelectChain([caseRow]);
        }
        if (call === 2) {
          return makeSelectChain([{
            body: "Tuve un choque. Poliza: POL-1234.",
            subject: "Siniestro",
            from_addr: SENDER_EMAIL,
          }]);
        }
        return makeSelectChain([]);
      });

      vi.mocked(db.update).mockReturnValue(makeUpdateChain(caseUpdateSpy) as any);
      vi.mocked(db.insert).mockReturnValue(makeInsertChain() as any);

      // Mock customer matcher to return a single high-confidence match.
      vi.mocked(findCustomerMatches).mockResolvedValue([HIGH_CONFIDENCE_MATCH]);

      // Mock policy matcher to return a policy match.
      vi.mocked(findPolicyMatches).mockResolvedValue([
        {
          policyId: "policy-uuid-001",
          policyNumber: "POL-4471-A",
          policyType: "auto",
          status: "active",
          customerName: "Ana García",
          confidence: 0.95,
        },
      ]);

      // Set up extractEmailClaimMock to return a valid claim.
      vi.mocked(extractEmailClaimMock).mockReturnValue(extraccion({
        extraction_model: "mock-email-v1",
        fields: [
          { field_key: "policy_number", field_value: "POL-1234",   confidence: 0.92, source: "ai" as const },
          { field_key: "full_name",     field_value: "Juan Pérez", confidence: 0.92, source: "ai" as const },
        ],
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
        is_claim: true,
        confidence: 0.92,
        extracted_fields: { policy_number: "POL-1234", full_name: "Juan Pérez" },
        field_confidences: {},
        missing_fields: [],
        fields_pending_confirmation: [],
        possible_customer_matches: [],
        possible_policy_matches: [],
        severity: "medium",
        requires_specialist: false,
        not_relevant_reason: undefined,
        summary: "Choque claim",
        suggested_reply: "",
      }));

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
    30_000
  );
});
