/**
 * Regression tests — Gemini provider error path in runEmailExtractionWorker.
 *
 * Bug: when extractEmailClaimGemini threw GeminiExtractionError the case was
 * correctly set to "escalado" but NO agent_run row was written, making the
 * failure invisible in the training panel and audit trail.
 *
 * Fix: logAgentRunError() is now called in the GeminiExtractionError catch block.
 *
 * These tests pin that behaviour so it cannot silently regress.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted shared state ───────────────────────────────────────────────────────

const {
  GeminiExtractionError,
  mockExtractEmailClaimGemini,
  mockLogAgentRunError,
  mockLogAgentRun,
  mockCheckBudget,
  mockFindCustomerMatches,
  mockFindPolicyMatches,
} = vi.hoisted(() => {
  /*
   * El doble tiene que llevar `cause`, como la clase de verdad.
   *
   * Sin eso, el `error_status` y el `error_code` que el worker saca del `cause`
   * salían siempre null, y el registro de un caso escalado por proveedor no
   * decía si había sido un 429 de cupo o un 500. El doble aceptaba un mensaje y
   * nada más, así que ese camino no se ejercitaba: la firma de la clase real es
   * `(message, cause?)`.
   */
  const GeminiErrClass = class GeminiExtractionError extends Error {
    constructor(msg: string, public readonly cause?: unknown) {
      super(msg);
      this.name = "GeminiExtractionError";
    }
  };
  return {
    GeminiExtractionError: GeminiErrClass,
    mockExtractEmailClaimGemini: vi.fn(),
    mockLogAgentRunError: vi.fn(),
    mockLogAgentRun: vi.fn(),
    mockCheckBudget: vi.fn(),
    mockFindCustomerMatches: vi.fn(),
    mockFindPolicyMatches: vi.fn(),
  };
});

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

vi.mock("server-only", () => ({}));

vi.mock("@/server/ai/gemini-extractor", () => ({
  extractEmailClaimGemini: mockExtractEmailClaimGemini,
  runGeminiExtractor: vi.fn(),
  GeminiExtractionError,
}));

vi.mock("@/server/ai/openai-extractor", () => ({
  extractEmailClaim: vi.fn(),
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

vi.mock("@/server/ai/provider", () => ({
  resolveExtractionEngine: vi.fn().mockResolvedValue("gemini"),
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
  logAgentRun: mockLogAgentRun,
  logAgentRunError: mockLogAgentRunError,
}));

vi.mock("@/server/memory/load", () => ({
  loadMemoryHints: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/server/training/custom-fields", () => ({
  loadActiveCustomFields: vi.fn().mockResolvedValue([]),
  formatCustomFields: vi.fn().mockReturnValue(""),
}));

vi.mock("@/server/ai/hydrate-fields", () => ({
  hydrateFieldsFromExtracted: vi.fn((c: unknown) => c),
  scrubPiiFromSummary: vi.fn((s: string) => s),
}));

vi.mock("@/server/intake/simulation-throttle", () => ({
  waitForEmailExtractionTurn: vi.fn().mockResolvedValue({ waitedMs: 0, timedOut: false, blockers: [] }),
  waitForSimulationTurn: vi.fn().mockResolvedValue({ waitedMs: 0, timedOut: false, blockers: [] }),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

/*
 * El `db` simulado sale de `db-simulado.ts`, compartido con los otros archivos
 * de test del worker. Los `vi.mock(...)` de arriba se quedan: se izan por
 * encima de los imports y tienen que estar escritos en cada archivo.
 */
let capturedCaseUpdates: Array<{ status?: string; updated_at?: string }> = [];

vi.mock("@/lib/db", () => {
  const mockDb = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), $count: vi.fn() };
  return { db: mockDb, tables: {} };
});

// ── Import worker AFTER all mocks ─────────────────────────────────────────────

import { runEmailExtractionWorker } from "@/server/worker/extract";
import { db } from "@/lib/db";
import { instalarDbSimulado } from "./db-simulado";

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupDbMock() {
  capturedCaseUpdates = [];
  instalarDbSimulado(db as unknown as Record<string, unknown>, {
    caso: {
      id: "case-gemini-err",
      channel: "email_sim",
      email_thread_id: null,
      policyholder_name: "Ana García",
      policy_number: "POL-987",
      created_at: "2024-01-01T00:00:00Z",
    },
    mensaje: {
      body: "Hola, tuve un siniestro hoy en la autopista.",
      subject: "Reclamo de siniestro",
      from_addr: "ana.garcia@example.com",
    },
    alActualizar: (datos) => capturedCaseUpdates.push(datos),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GEMINI-ERR: logAgentRunError is called when GeminiExtractionError is thrown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MOCK_AI;
    setupDbMock();
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockFindCustomerMatches.mockResolvedValue([]);
    mockFindPolicyMatches.mockResolvedValue([]);
    mockLogAgentRunError.mockResolvedValue("err-run-id");
    mockLogAgentRun.mockResolvedValue(undefined);

    // Simulate a Gemini 429 failure
    mockExtractEmailClaimGemini.mockRejectedValue(
      new GeminiExtractionError("429 RESOURCE_EXHAUSTED: quota exceeded", {
        status: 429,
        code: "RESOURCE_EXHAUSTED",
      })
    );
  });

  it("calls logAgentRunError exactly once", async () => {
    await runEmailExtractionWorker("case-gemini-err", "tenant-001", "user-001");

    expect(mockLogAgentRunError).toHaveBeenCalledTimes(1);
  });

  it("does NOT call logAgentRun (success logger) on failure", async () => {
    await runEmailExtractionWorker("case-gemini-err", "tenant-001", "user-001");

    expect(mockLogAgentRun).not.toHaveBeenCalled();
  });

  it("passes errorName='GeminiExtractionError' to logAgentRunError", async () => {
    await runEmailExtractionWorker("case-gemini-err", "tenant-001", "user-001");

    expect(mockLogAgentRunError).toHaveBeenCalledWith(
      expect.objectContaining({ errorName: "GeminiExtractionError" })
    );
  });

  it("passes the email subject and body to logAgentRunError for audit", async () => {
    await runEmailExtractionWorker("case-gemini-err", "tenant-001", "user-001");

    expect(mockLogAgentRunError).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          subject: "Reclamo de siniestro",
          body: "Hola, tuve un siniestro hoy en la autopista.",
        }),
      })
    );
  });

  it("passes the correct tenantId and caseId", async () => {
    await runEmailExtractionWorker("case-gemini-err", "tenant-001", "user-001");

    expect(mockLogAgentRunError).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-001",
        caseId: "case-gemini-err",
      })
    );
  });

  it("sets the case status to 'escalado' via DB update", async () => {
    await runEmailExtractionWorker("case-gemini-err", "tenant-001", "user-001");

    const escaladoUpdate = capturedCaseUpdates.find((u) => u.status === "escalado");
    expect(escaladoUpdate).toBeDefined();
  });

  /*
   * Qué dijo el proveedor queda en el registro.
   *
   * Es lo único que distingue «Gemini devolvió 429 por cupo» de «Gemini devolvió
   * 500», y es lo que se mira cuando aparecen veinte casos escalados de golpe.
   * No lo afirmaba nadie: escribirlo o no escribirlo daba lo mismo para la
   * suite, justo cuando este bloque se unificó con `escalateCase`.
   */
  it("el registro guarda el estado y el nombre del error del proveedor", async () => {
    const { writeAuditLog } = await import("@/lib/audit/log");

    await runEmailExtractionWorker("case-gemini-err", "tenant-001", "user-001");

    const escalado = vi
      .mocked(writeAuditLog)
      .mock.calls.map((c) => c[0])
      .find((e) => (e.payload as { new_status?: string })?.new_status === "escalado");

    expect(escalado).toBeDefined();
    const payload = escalado!.payload as Record<string, unknown>;
    expect(payload.reason).toBe("provider_error");
    expect(payload.error_status).toBe(429);
    expect(payload.error_name).toBeDefined();
  });

  it("does not throw — worker is fire-and-forget", async () => {
    await expect(
      runEmailExtractionWorker("case-gemini-err", "tenant-001", "user-001")
    ).resolves.toBeUndefined();
  });
});

describe("GEMINI-ERR: logAgentRunError is still called when logAgentRunError itself throws", () => {
  it("worker does not throw even if logAgentRunError rejects", async () => {
    vi.clearAllMocks();
    setupDbMock();
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockLogAgentRunError.mockRejectedValue(new Error("DB down"));
    mockExtractEmailClaimGemini.mockRejectedValue(
      new GeminiExtractionError("quota exceeded")
    );

    await expect(
      runEmailExtractionWorker("case-gemini-err", "tenant-001", "user-001")
    ).resolves.toBeUndefined();
  });
});

describe("BUDGET-EXCEEDED: case is escalated when internal budget guard fires", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MOCK_AI;
    setupDbMock();
    mockCheckBudget.mockResolvedValue({ exceeded: true, reason: "monthly_cap" });
    mockFindCustomerMatches.mockResolvedValue([]);
    mockFindPolicyMatches.mockResolvedValue([]);
    mockLogAgentRunError.mockResolvedValue("err-run-id");
    mockLogAgentRun.mockResolvedValue(undefined);
    // Gemini should never be called when budget is exceeded
    mockExtractEmailClaimGemini.mockRejectedValue(new Error("should not be called"));
  });

  it("sets case status to 'escalado' when budget is exceeded", async () => {
    await runEmailExtractionWorker("case-budget-exceeded", "tenant-001", "user-001");

    const escaladoUpdate = capturedCaseUpdates.find((u) => u.status === "escalado");
    expect(escaladoUpdate).toBeDefined();
  });

  it("does not call Gemini extractor when budget is exceeded", async () => {
    await runEmailExtractionWorker("case-budget-exceeded", "tenant-001", "user-001");

    expect(mockExtractEmailClaimGemini).not.toHaveBeenCalled();
  });

  it("does not call logAgentRun or logAgentRunError (no extraction attempted)", async () => {
    await runEmailExtractionWorker("case-budget-exceeded", "tenant-001", "user-001");

    expect(mockLogAgentRun).not.toHaveBeenCalled();
    expect(mockLogAgentRunError).not.toHaveBeenCalled();
  });

  it("does not throw — worker is fire-and-forget", async () => {
    await expect(
      runEmailExtractionWorker("case-budget-exceeded", "tenant-001", "user-001")
    ).resolves.toBeUndefined();
  });
});
