/**
 * La retoma de un caso que ya tuvo una extracción sin terminar.
 *
 * La señal es `intentos_de_extraccion > 0` en la fila del caso, que
 * `reintentarPorTimeout` suma en cada falla pasajera (TIMEOUT, 429, red). El
 * worker no tiene columna ni consulta nuevas: sólo lee ese contador en el mismo
 * SELECT del caso y se lo pasa al extractor como `trasCorte`.
 *
 * Qué hace el extractor con la señal está en `tests/unit/retoma-tras-corte.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted shared state ───────────────────────────────────────────────────────

const {
  mockExtractEmailClaimGemini,
  mockLogAgentRunError,
  mockLogAgentRun,
  mockCheckBudget,
  mockFindCustomerMatches,
  mockFindPolicyMatches,
  mockProgramarRetoma,
} = vi.hoisted(() => {
  return {
    mockExtractEmailClaimGemini: vi.fn(),
    mockLogAgentRunError: vi.fn(),
    mockLogAgentRun: vi.fn(),
    mockCheckBudget: vi.fn(),
    mockFindCustomerMatches: vi.fn(),
    mockFindPolicyMatches: vi.fn(),
    mockProgramarRetoma: vi.fn(),
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/data/scope", () => import("../../../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

vi.mock("server-only", () => ({}));

// La clase, `errMeta` y `esPasajero` de verdad: con qué criterio el worker
// reintenta o escala es parte de lo que se prueba acá.
vi.mock("@/server/ai/gemini-extractor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/ai/gemini-extractor")>()),
  extractEmailClaimGemini: mockExtractEmailClaimGemini,
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
  gravedadSinHechosNuevos: (severidad: unknown) => severidad,
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
  hydrateFieldsFromExtracted: vi.fn().mockReturnValue([]),
  scrubPiiFromSummary: vi.fn((s: string) => s),
}));

// El arranque del flujo durable no corre acá: se mira con qué caso se lo pidió.
vi.mock("@/server/intake/programar-retoma", () => ({ programarRetoma: mockProgramarRetoma }));

vi.mock("@/server/intake/simulation-throttle", () => ({
  waitForEmailExtractionTurn: vi.fn().mockResolvedValue({ waitedMs: 0, timedOut: false, blockers: [] }),
  waitForSimulationTurn: vi.fn().mockResolvedValue({ waitedMs: 0, timedOut: false, blockers: [] }),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

let capturedCaseUpdates: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => {
  const mockDb = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), $count: vi.fn() };
  return { db: mockDb, tables: {} };
});

// ── Import worker AFTER all mocks ─────────────────────────────────────────────

import { runEmailExtractionWorker } from "@/server/worker/extract";
import { GeminiExtractionError } from "@/server/ai/gemini-extractor";
import { db } from "@/lib/db";
import { instalarDbSimulado } from "./db-simulado";
import { extraccion } from "../../../helpers/extraccion";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RECLAMO = extraccion({
  extraction_model: "gemini-2.5-flash",
  fields: [],
  prompt_tokens: 0,
  completion_tokens: 0,
  cost_usd: 0,
  is_claim: true,
  missing_fields: ["dni"],
  severity: "medium",
  requires_specialist: false,
});

function setupDbMock(caso: Record<string, unknown> = {}) {
  capturedCaseUpdates = [];
  return instalarDbSimulado(db as unknown as Record<string, unknown>, {
    caso: {
      id: "case-retoma",
      channel: "email_sim",
      email_thread_id: null,
      policyholder_name: "Ana García",
      policy_number: "POL-987",
      created_at: "2024-01-01T00:00:00Z",
      ...caso,
    },
    mensaje: {
      body: "Hola, tuve un siniestro hoy en la autopista.",
      subject: "Reclamo de siniestro",
      from_addr: "ana.garcia@example.com",
    },
    alActualizar: (datos) => capturedCaseUpdates.push(datos),
  });
}

/** Lo que recibió el extractor en su primera llamada. */
function payloadDelExtractor(): Record<string, unknown> {
  expect(mockExtractEmailClaimGemini).toHaveBeenCalledTimes(1);
  return mockExtractEmailClaimGemini.mock.calls[0]![0] as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("el worker pasa al extractor si el caso viene de un intento sin terminar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MOCK_AI;
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockFindCustomerMatches.mockResolvedValue([]);
    mockFindPolicyMatches.mockResolvedValue([]);
    mockLogAgentRunError.mockResolvedValue("err-run-id");
    mockLogAgentRun.mockResolvedValue(undefined);
    mockExtractEmailClaimGemini.mockResolvedValue(RECLAMO);
  });

  it.each([1, 2, 3])("con %i intento(s) previo(s) el payload lleva trasCorte: true", async (intentos) => {
    setupDbMock({ intentos_de_extraccion: intentos });

    await runEmailExtractionWorker("case-retoma", "tenant-001", "user-001");

    expect(payloadDelExtractor().trasCorte).toBe(true);
  });

  it("sin intentos previos el payload no trae trasCorte", async () => {
    setupDbMock({ intentos_de_extraccion: 0 });

    await runEmailExtractionWorker("case-retoma", "tenant-001", "user-001");

    expect(payloadDelExtractor()).not.toHaveProperty("trasCorte");
  });

  it("una fila sin el contador se trata como sin intentos", async () => {
    setupDbMock();

    await runEmailExtractionWorker("case-retoma", "tenant-001", "user-001");

    expect(payloadDelExtractor()).not.toHaveProperty("trasCorte");
  });

  it("el contador sale en el mismo SELECT del caso, sin consulta nueva", async () => {
    const simulado = setupDbMock({ intentos_de_extraccion: 1 });

    await runEmailExtractionWorker("case-retoma", "tenant-001", "user-001");

    const primera = simulado.select.mock.calls[0]![0] as Record<string, unknown>;
    expect(primera).toHaveProperty("intentos_de_extraccion");
    expect(primera).toHaveProperty("status");
    expect(primera).toHaveProperty("channel");
  });

  it("el contador no vuelve a cero cuando la corrida sale bien", async () => {
    setupDbMock({ intentos_de_extraccion: 2 });

    await runEmailExtractionWorker("case-retoma", "tenant-001", "user-001");

    expect(mockExtractEmailClaimGemini).toHaveBeenCalledTimes(1);
    expect(capturedCaseUpdates.some((u) => "intentos_de_extraccion" in u)).toBe(false);
    expect(mockProgramarRetoma).not.toHaveBeenCalled();
  });
});

describe("el reintento por falla pasajera sigue como antes, también en una retoma", () => {
  const ERRORES = [
    ["TIMEOUT", () => new GeminiExtractionError("timeout", { code: "TIMEOUT" })],
    ["429", () => new GeminiExtractionError("429 RESOURCE_EXHAUSTED", { status: 429, code: "RESOURCE_EXHAUSTED" })],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MOCK_AI;
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockFindCustomerMatches.mockResolvedValue([]);
    mockFindPolicyMatches.mockResolvedValue([]);
    mockLogAgentRunError.mockResolvedValue("err-run-id");
    mockLogAgentRun.mockResolvedValue(undefined);
  });

  it.each(ERRORES)("un %s en la retoma vuelve a la cola sumando un intento y no escala", async (_, error) => {
    setupDbMock({ intentos_de_extraccion: 1 });
    mockExtractEmailClaimGemini.mockRejectedValue(error());

    await runEmailExtractionWorker("case-retoma", "tenant-001", "user-001");

    expect(payloadDelExtractor().trasCorte).toBe(true);
    expect(capturedCaseUpdates).toContainEqual(
      expect.objectContaining({ extraction_pending: true, intentos_de_extraccion: expect.anything() })
    );
    expect(capturedCaseUpdates.find((u) => u.status === "escalado")).toBeUndefined();
    expect(mockLogAgentRunError).not.toHaveBeenCalled();
    expect(mockProgramarRetoma).toHaveBeenCalledTimes(1);
    expect(mockProgramarRetoma).toHaveBeenCalledWith("case-retoma", "tenant-001");
  });

  it("el primer TIMEOUT de un caso va a la cola sin la señal", async () => {
    setupDbMock({ intentos_de_extraccion: 0 });
    mockExtractEmailClaimGemini.mockRejectedValue(ERRORES[0][1]());

    await runEmailExtractionWorker("case-retoma", "tenant-001", "user-001");

    expect(payloadDelExtractor()).not.toHaveProperty("trasCorte");
    expect(capturedCaseUpdates).toContainEqual(
      expect.objectContaining({ extraction_pending: true, intentos_de_extraccion: expect.anything() })
    );
    expect(capturedCaseUpdates.find((u) => u.status === "escalado")).toBeUndefined();
    expect(mockProgramarRetoma).toHaveBeenCalledTimes(1);
    expect(mockProgramarRetoma).toHaveBeenCalledWith("case-retoma", "tenant-001");
  });

  it("pide la retoma recién cuando la reserva ya está suelta", async () => {
    // La retoma la toma por la reserva: si se encolara antes de soltarla,
    // el flujo podría despertar y encontrarla viva.
    setupDbMock({ intentos_de_extraccion: 0 });
    mockExtractEmailClaimGemini.mockRejectedValue(ERRORES[0][1]());
    let alPedirla: Array<Record<string, unknown>> = [];
    mockProgramarRetoma.mockImplementation(async () => {
      alPedirla = [...capturedCaseUpdates];
    });

    await runEmailExtractionWorker("case-retoma", "tenant-001", "user-001");

    expect(mockProgramarRetoma).toHaveBeenCalledTimes(1);
    expect(alPedirla).toContainEqual(expect.objectContaining({ extraction_lease_at: null }));
  });

  it("con los intentos agotados escala como error del proveedor, señal o no", async () => {
    setupDbMock({ intentos_de_extraccion: 3 });
    type Cadena = { set: (datos: Record<string, unknown>) => unknown };
    const actualizar = db.update as unknown as ReturnType<typeof vi.fn>;
    const armar = actualizar.getMockImplementation() as (...a: unknown[]) => Cadena;
    actualizar.mockImplementation((...a: unknown[]) => {
      const cadena = armar(...a);
      return {
        set: (datos: Record<string, unknown>) =>
          "intentos_de_extraccion" in datos
            ? { where: () => Object.assign(Promise.resolve({ rowCount: 0 }), { returning: () => Promise.resolve([]) }) }
            : cadena.set(datos),
      };
    });
    mockExtractEmailClaimGemini.mockRejectedValue(ERRORES[0][1]());

    await runEmailExtractionWorker("case-retoma", "tenant-001", "user-001");

    expect(payloadDelExtractor().trasCorte).toBe(true);
    expect(capturedCaseUpdates.find((u) => u.status === "escalado")).toBeDefined();
    expect(mockLogAgentRunError).toHaveBeenCalledTimes(1);
    expect(mockProgramarRetoma).not.toHaveBeenCalled();
  });
});
