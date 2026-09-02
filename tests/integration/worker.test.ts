/**
 * Integration tests for the AI extraction worker.
 *
 * AC5: procesando → listo when all required fields extracted with confidence >= 0.70
 * AC6: procesando → esperando when required docs missing; creates outbound_messages
 * AC7: procesando → escalado when confidence < 0.70 on required fields
 * AC8: MOCK_AI=true path completes deterministically
 * AC17: Prompt injection cannot set case.status to cerrado
 * AC18: Worker logs never contain raw_intake_text
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  mockRunMockExtractor,
  mockRunGeminiExtractor,
  mockCheckBudget,
  mockResolveExtractionEngine,
  mockDbHolder,
} = vi.hoisted(() => {
  // ── Captured state (must be hoisted so vi.mock factory can close over them) ──
  const state = {
    capturedUpdateArgs: [] as Record<string, unknown>[],
    capturedMissingDocsInsert: false,
    capturedOutboundInsert: false,
  };

  /**
   * Build a mock Drizzle db where:
   *  - select call #1 → [caseRow]          (cases query)
   *  - select call #2 → [rawMessageData]   (raw_messages query)
   *  - select call #3+ → []                (missingDocs existing-keys query)
   *  - update().set(args) → captures args
   *  - insert().values() → captures outbound/missingDocs flags
   */
  function buildMockDb(
    caseData: Record<string, unknown>,
    rawMessageData: { body: string } | null = {
      body: "El 15/03/2024 tuve un choque en Av. Corrientes al 2400. Adjunto parte amistoso, fotos y licencia.",
    }
  ) {
    state.capturedUpdateArgs = [];
    state.capturedMissingDocsInsert = false;
    state.capturedOutboundInsert = false;

    let selectCallIdx = 0;

    const mockSelect = vi.fn().mockImplementation(() => {
      selectCallIdx++;
      const idx = selectCallIdx;

      const limitFn = vi.fn().mockImplementation(() => {
        if (idx === 1) return Promise.resolve([caseData]);
        // missingDocs select (insertMissingDocsIfAbsent existing-keys check)
        return Promise.resolve([]);
      });

      const orderByFn = vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(() => {
          if (idx === 2) {
            // raw_messages query
            return rawMessageData ? Promise.resolve([rawMessageData]) : Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      });

      const whereFn = vi.fn().mockReturnValue({
        limit: limitFn,
        orderBy: orderByFn,
      });

      return { from: vi.fn().mockReturnValue({ where: whereFn }) };
    });

    const mockUpdate = vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((args: Record<string, unknown>) => {
        state.capturedUpdateArgs.push(args);
        return { where: vi.fn().mockResolvedValue({ rowCount: 1 }) };
      }),
    }));

    const mockInsert = vi.fn().mockImplementation(() => {
      const valuesChain = {
        onConflictDoUpdate: vi.fn().mockResolvedValue({ rowCount: 1 }),
        then: (
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown
        ) => Promise.resolve({ rowCount: 1 }).then(resolve, reject),
        catch: (fn?: (e: unknown) => unknown) =>
          Promise.resolve({ rowCount: 1 }).catch(fn ?? undefined),
        finally: (fn?: () => void) =>
          Promise.resolve({ rowCount: 1 }).finally(fn ?? undefined),
      };

      return {
        values: vi.fn().mockImplementation((rows: unknown) => {
          const firstRow = Array.isArray(rows) ? rows[0] : rows;
          if (
            firstRow &&
            typeof firstRow === "object" &&
            "template" in (firstRow as object)
          ) {
            // outbound_messages insert
            state.capturedOutboundInsert = true;
          } else {
            // missing_docs or extracted_fields insert
            state.capturedMissingDocsInsert = true;
          }
          return valuesChain;
        }),
      };
    });

    return {
      select: mockSelect,
      update: mockUpdate,
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowCount: 0 }) }),
      $count: vi.fn().mockResolvedValue(0),
    };
  }

  // Holder exposes state + builder so tests can read captured data and rebuild.
  const holder = {
    state,
    buildMockDb,
    current: buildMockDb({
      id: "case-001",
      status: "procesando",
      claim_type: "choque",
      tenant_id: "tenant-001",
      channel: "legacy_sim",
    }),
  };

  return {
    mockRunMockExtractor: vi.fn(),
    mockRunGeminiExtractor: vi.fn(),
    mockCheckBudget: vi.fn(),
    mockResolveExtractionEngine: vi.fn(),
    mockDbHolder: holder,
  };
});

// ── Mock all external dependencies ────────────────────────────────────────────

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
  runMockExtractor: mockRunMockExtractor,
  extractEmailClaimMock: vi.fn(),
}));

vi.mock("@/server/ai/gemini-extractor", () => ({
  runGeminiExtractor: mockRunGeminiExtractor,
  extractEmailClaimGemini: vi.fn(),
  GeminiExtractionError: class GeminiExtractionError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "GeminiExtractionError";
    }
  },
}));

vi.mock("@/server/ai/provider", () => ({
  resolveExtractionEngine: mockResolveExtractionEngine,
}));

vi.mock("@/server/ai/budget", () => ({
  checkBudget: mockCheckBudget,
  recordUsage: vi.fn().mockResolvedValue(undefined),
  computeCostUsd: vi.fn().mockReturnValue(0),
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
    EXTRACTION_COMPLETE: "claim.extraction_complete",
    SPECIALIST_REQUIRED: "claim.specialist_required",
    MEMORY_APPLIED: "claim.memory_applied",
  },
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

vi.mock("@/server/ai/severity-classifier", () => ({
  classifySeverity: vi.fn().mockReturnValue("medium"),
  requiresSpecialist: vi.fn().mockReturnValue(false),
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
  getActivePromptVersion: vi.fn().mockResolvedValue({ id: null, version: 0, systemPrompt: null }),
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
  scrubPiiFromSummary: vi.fn().mockImplementation((x: unknown) => x),
}));

vi.mock("@/lib/email/claim-parser", () => ({
  mergeExtractedFields: vi.fn().mockImplementation((a: unknown[]) => a),
  parseEmailClaimFields: vi.fn().mockReturnValue([]),
}));

// ── Mock @/lib/db using the hoisted holder ─────────────────────────────────────

vi.mock("@/lib/db", () => ({
  // Use a getter so tests can swap mockDbHolder.current between runs.
  get db() {
    return mockDbHolder.current;
  },
  tables: {},
}));

// ── Import worker after mocks ─────────────────────────────────────────────────

import { runExtractionWorker } from "@/server/worker/extract";
import { extraccion } from "../helpers/extraccion";

// ── Constants ─────────────────────────────────────────────────────────────────

const MOCK_CASE_DATA = {
  id: "case-001",
  status: "procesando",
  claim_type: "choque",
  tenant_id: "tenant-001",
  channel: "legacy_sim",
};

// ── Helper: build mock extraction results ─────────────────────────────────────

function choqueAllFields(confidence = 0.85): ExtractedClaim {
  return extraccion({
    extraction_model: "mock-v1",
    fields: [
      { field_key: "incident_date", field_value: "15/03/2024", confidence, source: "ai" as const },
      { field_key: "incident_location", field_value: "Av. Corrientes 2400", confidence, source: "ai" as const },
      { field_key: "parte_amistoso", field_value: "si", confidence, source: "ai" as const },
      { field_key: "fotos_danos", field_value: "si", confidence, source: "ai" as const },
      { field_key: "licencia_conducir", field_value: "si", confidence, source: "ai" as const },
    ],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
  });
}

function choqueMissingDocs(confidence = 0.85): ExtractedClaim {
  return extraccion({
    extraction_model: "mock-v1",
    fields: [
      { field_key: "incident_date", field_value: "15/03/2024", confidence, source: "ai" as const },
      // parte_amistoso MISSING
      { field_key: "fotos_danos", field_value: "si", confidence, source: "ai" as const },
      { field_key: "licencia_conducir", field_value: "si", confidence, source: "ai" as const },
    ],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
  });
}

function choqueAllLowConfidence(): ExtractedClaim {
  return extraccion({
    extraction_model: "mock-v1",
    fields: [
      { field_key: "parte_amistoso", field_value: "si", confidence: 0.45, source: "ai" as const }, // LOW
      { field_key: "fotos_danos", field_value: "si", confidence: 0.85, source: "ai" as const },
      { field_key: "licencia_conducir", field_value: "si", confidence: 0.88, source: "ai" as const },
    ],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runExtractionWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOCK_AI = "true";
    process.env.OPENAI_API_KEY = "";
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockResolveExtractionEngine.mockResolvedValue("mock");
    // Reset the db mock with fresh state for the default case.
    mockDbHolder.current = mockDbHolder.buildMockDb(MOCK_CASE_DATA);
  });

  // ── AC5: listo path ────────────────────────────────────────────────────────

  it("AC5: transitions to listo when all required fields present with confidence >= 0.70", async () => {
    mockRunMockExtractor.mockReturnValue(choqueAllFields(0.85));

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    expect(mockRunMockExtractor).toHaveBeenCalledOnce();
    const statusUpdates = mockDbHolder.state.capturedUpdateArgs.map((a) => a.status);
    expect(statusUpdates).toContain("listo");
    expect(statusUpdates).not.toContain("cerrado");
  });

  // ── AC6: esperando path ────────────────────────────────────────────────────

  it("AC6: transitions to esperando when required docs missing", async () => {
    mockRunMockExtractor.mockReturnValue(choqueMissingDocs(0.85));
    mockDbHolder.current = mockDbHolder.buildMockDb(MOCK_CASE_DATA);

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    const statusUpdates = mockDbHolder.state.capturedUpdateArgs.map((a) => a.status);
    expect(statusUpdates).toContain("esperando");
    expect(mockDbHolder.state.capturedMissingDocsInsert).toBe(true);
    expect(mockDbHolder.state.capturedOutboundInsert).toBe(true);
  });

  // ── AC7: escalado path ─────────────────────────────────────────────────────

  it("AC7: transitions to escalado when all docs present but confidence < 0.70", async () => {
    mockRunMockExtractor.mockReturnValue(choqueAllLowConfidence());

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    const statusUpdates = mockDbHolder.state.capturedUpdateArgs.map((a) => a.status);
    expect(statusUpdates).toContain("escalado");
  });

  // ── AC17: Prompt injection containment ─────────────────────────────────────

  it("AC17: prompt injection in email body cannot set status to cerrado", async () => {
    mockRunMockExtractor.mockReturnValue({
      extraction_model: "mock-v1",
      fields: [
        { field_key: "parte_amistoso", field_value: "si", confidence: 0.85, source: "ai" as const },
        { field_key: "fotos_danos", field_value: "si", confidence: 0.85, source: "ai" as const },
        { field_key: "licencia_conducir", field_value: "si", confidence: 0.85, source: "ai" as const },
        // Injected fields — should be ignored for status determination.
        { field_key: "status", field_value: "cerrado", confidence: 1.0, source: "ai" as const },
        { field_key: "case_status", field_value: "listo", confidence: 1.0, source: "ai" as const },
      ],
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
    });

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    for (const args of mockDbHolder.state.capturedUpdateArgs) {
      expect(args.status).not.toBe("cerrado");
      expect(args.status).not.toBe("procesando");
      expect(["listo", "esperando", "escalado"]).toContain(args.status);
    }
  });

  // ── AI output invalid → escalado ───────────────────────────────────────────

  it("un fallo de extraccion escala el caso, no lo deja a medias", async () => {
    mockResolveExtractionEngine.mockResolvedValue("gemini");

    const { GeminiExtractionError } = await import("@/server/ai/gemini-extractor");
    mockRunGeminiExtractor.mockRejectedValue(
      new GeminiExtractionError("AI output invalid after retry")
    );

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    const statusUpdates = mockDbHolder.state.capturedUpdateArgs.map((a) => a.status);
    expect(statusUpdates).toContain("escalado");
  });

  // ── AC18: PII not logged ───────────────────────────────────────────────────

  it("AC18: worker logs do not contain raw email text", async () => {
    mockRunMockExtractor.mockReturnValue(choqueAllFields(0.85));

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    const allOutput = [
      ...stdoutSpy.mock.calls.map((c) => String(c[0])),
      ...stderrSpy.mock.calls.map((c) => String(c[0])),
    ].join("\n");

    expect(allOutput).not.toContain("El 15/03/2024 tuve un choque en Av. Corrientes");
    expect(allOutput).not.toContain("parte amistoso");

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // ── Budget exceeded → escalado ─────────────────────────────────────────────

  it("escalates to escalado when budget is exceeded", async () => {
    mockCheckBudget.mockResolvedValue({
      exceeded: true,
      reason: "Monthly cap exceeded",
    });

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    const statusUpdates = mockDbHolder.state.capturedUpdateArgs.map((a) => a.status);
    expect(statusUpdates).toContain("escalado");
    expect(mockRunMockExtractor).not.toHaveBeenCalled();
  });

  // ── Case not in procesando → skip ─────────────────────────────────────────

  it("skips worker if case is not in procesando status", async () => {
    mockDbHolder.current = mockDbHolder.buildMockDb({ ...MOCK_CASE_DATA, status: "listo" });

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    expect(mockRunMockExtractor).not.toHaveBeenCalled();
  });

  // ── FSM validation ─────────────────────────────────────────────────────────

  /*
   * Este test recorría las escrituras y afirmaba adentro de un
   * `if (args.status !== undefined)`. Si el worker no escribía NINGÚN estado
   * —un caso que se queda en `procesando` para siempre, que es una falla peor
   * que transicionar mal— el bucle no daba una vuelta y el test pasaba.
   *
   * Ahora afirma las dos cosas: que escribió al menos uno, y que todos los que
   * escribió están permitidos.
   *
   * Medido con los dos mutantes, para no exagerar lo que cuida:
   *
   *   · estado prohibido (`cerrado`) → lo caza
   *   · sacar `caseUpdate.status`    → NO lo caza, porque en este camino hay
   *     otro escritor que igual deja «listo». O sea que la guarda de «al menos
   *     uno» cubre que el caso no quede colgado, no que lo escriba una línea en
   *     particular. Es lo que dice el nombre del test, y nada más.
   */
  it("FSM: procesando can only transition to listo, esperando, or escalado", async () => {
    mockRunMockExtractor.mockReturnValue(choqueAllFields(0.85));

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    const escritos = mockDbHolder.state.capturedUpdateArgs
      .map((args) => args.status)
      .filter((s): s is string => s !== undefined)
      .map(String);

    // Quedarse en `procesando` no es «no transicionar mal»: es un caso colgado.
    expect(escritos.length).toBeGreaterThan(0);

    const ALLOWED = ["listo", "esperando", "escalado"];
    // El mensaje del error nombra el estado prohibido en vez de decir false.
    expect(escritos.filter((e) => !ALLOWED.includes(e))).toEqual([]);
  });
});
