/**
 * Unit tests for AI extractor field-copy + identity guard.
 *
 * Tests the field-copy logic inside runEmailExtractionWorker:
 *   - Lines 780-787 of src/server/worker/extract.ts
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
 *   - The mock db module (injected via @/lib/db mock) captures
 *     the cases.update() payload for assertion.
 *
 * Note: extract.ts is excluded from coverage by vitest.config.ts. Tests
 * still run against the live source — only coverage attribution is skipped.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";

// ── Static module mocks ───────────────────────────────────────────────────────
// vi.mock() calls are hoisted to the top of the file by Vitest.

// Mock the entire @/lib/db module — drizzle requires DATABASE_URL at init time.
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

vi.mock("@/lib/db", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { db: mockDb, tables: {} };
});

vi.mock("@/lib/db/helpers", () => ({
  firstRow: (rows: unknown[]) => rows[0] ?? null,
  ilikeAny: vi.fn(),
  countRows: vi.fn(),
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
  getActivePromptVersion: vi.fn().mockResolvedValue({ id: null, version: 1, systemPrompt: null }),
}));

vi.mock("@/server/training/trainability", () => ({
  assessTrainability: vi.fn().mockReturnValue({ trainable: false }),
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
  scrubPiiFromSummary: vi.fn().mockImplementation((c: unknown) => c),
}));

vi.mock("@/lib/email/claim-parser", () => ({
  mergeExtractedFields: vi.fn().mockImplementation((a: unknown[], _b: unknown[]) => a),
  parseEmailClaimFields: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/schemas/cases", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/schemas/cases")>();
  return {
    ...actual,
    ClaimTypeSchema: { safeParse: vi.fn().mockReturnValue({ success: false }) },
  };
});

/**
 * Mock the mock-extractor module. extractEmailClaimMock is replaced with a
 * vi.fn() whose implementation is set per-test via mockReturnValue.
 * The worker calls extractEmailClaimMock() when engine === "mock".
 */
vi.mock("@/server/ai/mock-extractor", () => ({
  extractEmailClaimMock: vi.fn(),
  runMockExtractor: vi.fn(),
}));

// ── Imports (after vi.mock declarations) ─────────────────────────────────────

import { db } from "@/lib/db";
import { checkBudget } from "@/server/ai/budget";
import { isValidTransition } from "@/core/case/fsm";
import { classifySeverity, requiresSpecialist } from "@/server/ai/severity-classifier";
import { orchestratePostExtraction } from "@/server/confirmations/orchestrate";
import { findCustomerMatches } from "@/server/matching/customer-matcher";
import { findPolicyMatches } from "@/server/matching/policy-matcher";
import { extractEmailClaimMock } from "@/server/ai/mock-extractor";
import { runEmailExtractionWorker } from "@/server/worker/extract";
import { extraccion } from "../helpers/extraccion";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const CASE_ID   = "fc-test-0000-0000-0000-000000000001";
const TENANT_ID = "fc-test-0000-0000-0000-000000000002";

type MockDb = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

/**
 * Build a minimal valid ExtractedClaim with the given extracted_fields.
 * The worker reads extractedClaim.extracted_fields for the field-copy logic.
 */
function makeExtractedClaim(extractedFields: Record<string, string>): ExtractedClaim {
  return extraccion({
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
  });
}

/**
 * Configure the Drizzle db mocks for a worker run.
 *
 * caseRow: what the cases SELECT .limit(1) returns.
 * caseUpdateSpy: spy that captures each cases.update(.set(payload)...) call.
 *
 * The worker uses db.select() for:
 *   1. cases fetch — returns [caseRow]
 *   2. raw_messages fetch — returns [rawMsg]
 *   3. known_claim_patterns — returns []
 *   4. missingDocs existing check — returns []
 *
 * We use a call counter inside from() to differentiate them.
 */
function buildDbMocks(
  caseRow: Record<string, unknown>,
  caseUpdateSpy: Mock<(data: Record<string, unknown>) => void>
) {
  const mockDbTyped = db as unknown as MockDb;

  let selectCallCount = 0;

  mockDbTyped.select.mockImplementation(() => {
    selectCallCount++;
    const callNum = selectCallCount;

    if (callNum === 1) {
      // cases fetch — .where(...).limit(1)
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([caseRow]),
          }),
        }),
      };
    }

    if (callNum === 2) {
      // raw_messages fetch — .where(...).orderBy(...).limit(1)
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  body: "Stub email body for field-copy tests.",
                  subject: "Reclamo",
                  from_addr: "cliente@example.com",
                },
              ]),
            }),
          }),
        }),
      };
    }

    // All other selects (known_claim_patterns, missingDocs, etc.) — return empty
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
  });

  mockDbTyped.update.mockImplementation(() => ({
    set: vi.fn<(payload: unknown) => unknown>().mockImplementation((payload: unknown) => ({
      where: vi.fn().mockImplementation(() => {
        caseUpdateSpy(payload as Record<string, unknown>);
        return Promise.resolve(undefined);
      }),
    })),
  }));

  mockDbTyped.insert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  });

  mockDbTyped.delete.mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });
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
  const caseUpdateSpy = vi.fn<(data: Record<string, unknown>) => void>();
  buildDbMocks(caseRow, caseUpdateSpy);

  // The worker calls extractEmailClaimMock() when engine === "mock".
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
