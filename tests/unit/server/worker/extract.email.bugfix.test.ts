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
  extractEmailClaimGemini: mockExtractEmailClaim,
  runGeminiExtractor: vi.fn(),
  GeminiExtractionError: class GeminiExtractionError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "GeminiExtractionError";
    }
  },
}));

vi.mock("@/server/ai/provider", () => ({
  resolveExtractionEngine: vi.fn().mockResolvedValue("gemini"),
}));

vi.mock("@/server/ai/severity-classifier", () => ({
  classifySeverity: vi.fn().mockReturnValue("medium"),
  requiresSpecialist: vi.fn().mockReturnValue(false),
}));

vi.mock("@/core/case/fsm", () => ({
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
  logAgentRunError: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/server/memory/load", () => ({
  loadMemoryHints: vi.fn().mockResolvedValue([]),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

/** Captured insert calls for extracted_fields table */
/*
 * El `db` simulado sale de `db-simulado.ts`, compartido con los otros archivos
 * de test del worker. Acá estaba escrito entero y era el mismo que en
 * `extract.email.security` salvo por qué se anotaba de lo que se escribía, que
 * ahora es una opción.
 *
 * Los `vi.mock(...)` de arriba se quedan: se izan por encima de los imports.
 */
let capturedFieldInserts: Array<Array<{ field_key: string; field_value: string; confidence: string | number }>> = [];

let capturedCustomerMatcherInput: Record<string, string | undefined> = {};

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
import { instalarDbSimulado } from "./db-simulado";
import { findCustomerMatches } from "@/server/matching/customer-matcher";
import { extraccion } from "../../../helpers/extraccion";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBugPatternClaim(): ExtractedClaim {
  // BUG PATTERN: extracted_fields populated, fields[] empty
  return extraccion({
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
  });
}

function setupDbMock() {
  capturedFieldInserts = [];
  capturedCustomerMatcherInput = {};
  instalarDbSimulado(db as unknown as Record<string, unknown>, {
    mensaje: {
      body: "Buenos días. Soy NICOLAS JASPER. DU Nro.92310691. Siniestro 91520998-2.",
      subject: "Siniestro Zurich",
      from_addr: "n10jasper@gmail.com",
    },
    // Sólo interesan los de `extracted_fields`, y se reconocen por la columna:
    // el mismo espía lo comparten todas las inserciones del worker.
    alInsertar: (valores) => {
      const filas = Array.isArray(valores) ? valores : [valores];
      if (filas.length > 0 && filas[0] && "field_key" in (filas[0] as object)) {
        capturedFieldInserts.push(
          filas as Array<{ field_key: string; field_value: string; confidence: string | number }>
        );
      }
    },
  });
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
    const claimWithFieldsOnly: ExtractedClaim = extraccion({
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
    });

    mockExtractEmailClaim.mockResolvedValue(claimWithFieldsOnly);

    await runEmailExtractionWorker("case-001", "tenant-001", "user-001");

    expect(capturedCustomerMatcherInput.full_name).toBe("NICOLAS JASPER");
  });
});
