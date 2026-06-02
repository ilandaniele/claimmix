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

const { mockRunMockExtractor, mockRunOpenAIExtractor, mockCheckBudget } = vi.hoisted(() => ({
  mockRunMockExtractor: vi.fn(),
  mockRunOpenAIExtractor: vi.fn(),
  mockCheckBudget: vi.fn(),
}));

// ── Mock all external dependencies ────────────────────────────────────────────

vi.mock("@/server/ai/mock-extractor", () => ({
  runMockExtractor: mockRunMockExtractor,
}));

vi.mock("@/server/ai/openai-extractor", () => ({
  runOpenAIExtractor: mockRunOpenAIExtractor,
  OpenAIExtractionError: class OpenAIExtractionError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "OpenAIExtractionError";
    }
  },
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
  },
}));

// ── Mock service client factory ────────────────────────────────────────────────

/** Track update() calls to verify status transitions. */
let capturedUpdateArgs: Record<string, unknown>[] = [];
let capturedMissingDocsUpsert: boolean = false;
let capturedOutboundInsert: boolean = false;

function buildServiceMock(
  caseData: Record<string, unknown>,
  rawMessageData: { body: string } | null = { body: "El 15/03/2024 tuve un choque en Av. Corrientes al 2400. Adjunto parte amistoso, fotos y licencia." }
) {
  capturedUpdateArgs = [];
  capturedMissingDocsUpsert = false;
  capturedOutboundInsert = false;

  return {
    from: (table: string) => {
      if (table === "cases") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: caseData, error: null }),
          update: vi.fn().mockImplementation((args: Record<string, unknown>) => {
            capturedUpdateArgs.push(args);
            return { eq: vi.fn().mockResolvedValue({ error: null }) };
          }),
          upsert: vi.fn().mockResolvedValue({ error: null }),
        };
      }
      if (table === "raw_messages") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: rawMessageData,
            error: rawMessageData ? null : { code: "PGRST116" },
          }),
        };
      }
      if (table === "extracted_fields") {
        return { upsert: vi.fn().mockResolvedValue({ error: null }) };
      }
      if (table === "missing_docs") {
        return {
          upsert: vi.fn().mockImplementation(() => {
            capturedMissingDocsUpsert = true;
            return Promise.resolve({ error: null });
          }),
        };
      }
      if (table === "outbound_messages") {
        return {
          insert: vi.fn().mockImplementation(() => {
            capturedOutboundInsert = true;
            return Promise.resolve({ error: null });
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
        upsert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    },
  };
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

// ── Import worker after mocks ─────────────────────────────────────────────────

import { runExtractionWorker } from "@/server/worker/extract";

// ── Helper: build mock extraction results ─────────────────────────────────────

const MOCK_CASE_DATA = {
  id: "case-001",
  status: "procesando",
  claim_type: "choque",
  tenant_id: "tenant-001",
};

function choqueAllFields(confidence = 0.85): ExtractedClaim {
  return {
    extraction_model: "mock-v1",
    fields: [
      { field_key: "incident_date", field_value: "15/03/2024", confidence },
      { field_key: "incident_location", field_value: "Av. Corrientes 2400", confidence },
      { field_key: "parte_amistoso", field_value: "si", confidence },
      { field_key: "fotos_danos", field_value: "si", confidence },
      { field_key: "licencia_conducir", field_value: "si", confidence },
    ],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
  };
}

function choqueMissingDocs(confidence = 0.85): ExtractedClaim {
  return {
    extraction_model: "mock-v1",
    fields: [
      { field_key: "incident_date", field_value: "15/03/2024", confidence },
      // parte_amistoso MISSING
      { field_key: "fotos_danos", field_value: "si", confidence },
      { field_key: "licencia_conducir", field_value: "si", confidence },
    ],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
  };
}

function choqueAllLowConfidence(): ExtractedClaim {
  return {
    extraction_model: "mock-v1",
    fields: [
      { field_key: "parte_amistoso", field_value: "si", confidence: 0.45 }, // LOW
      { field_key: "fotos_danos", field_value: "si", confidence: 0.85 },
      { field_key: "licencia_conducir", field_value: "si", confidence: 0.88 },
    ],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runExtractionWorker", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.MOCK_AI = "true";
    process.env.OPENAI_API_KEY = "";
    mockCheckBudget.mockResolvedValue({ exceeded: false });

    const { createServiceClient } = await import("@/lib/supabase/service");
    vi.mocked(createServiceClient).mockReturnValue(
      buildServiceMock(MOCK_CASE_DATA) as unknown as ReturnType<typeof createServiceClient>
    );
  });

  // ── AC5: listo path ────────────────────────────────────────────────────────

  it("AC5: transitions to listo when all required fields present with confidence >= 0.70", async () => {
    mockRunMockExtractor.mockReturnValue(choqueAllFields(0.85));

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    expect(mockRunMockExtractor).toHaveBeenCalledOnce();
    const statusUpdates = capturedUpdateArgs.map((a) => a.status);
    expect(statusUpdates).toContain("listo");
    expect(statusUpdates).not.toContain("cerrado");
  });

  // ── AC6: esperando path ────────────────────────────────────────────────────

  it("AC6: transitions to esperando when required docs missing", async () => {
    mockRunMockExtractor.mockReturnValue(choqueMissingDocs(0.85));

    const { createServiceClient } = await import("@/lib/supabase/service");
    vi.mocked(createServiceClient).mockReturnValue(
      buildServiceMock(MOCK_CASE_DATA) as unknown as ReturnType<typeof createServiceClient>
    );

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    const statusUpdates = capturedUpdateArgs.map((a) => a.status);
    expect(statusUpdates).toContain("esperando");
    expect(capturedMissingDocsUpsert).toBe(true);
    expect(capturedOutboundInsert).toBe(true);
  });

  // ── AC7: escalado path ─────────────────────────────────────────────────────

  it("AC7: transitions to escalado when all docs present but confidence < 0.70", async () => {
    mockRunMockExtractor.mockReturnValue(choqueAllLowConfidence());

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    const statusUpdates = capturedUpdateArgs.map((a) => a.status);
    expect(statusUpdates).toContain("escalado");
  });

  // ── AC17: Prompt injection containment ─────────────────────────────────────

  it("AC17: prompt injection in email body cannot set status to cerrado", async () => {
    // Even with injected fields, worker only reads extracted field keys, not values for status.
    mockRunMockExtractor.mockReturnValue({
      extraction_model: "mock-v1",
      fields: [
        { field_key: "parte_amistoso", field_value: "si", confidence: 0.85 },
        { field_key: "fotos_danos", field_value: "si", confidence: 0.85 },
        { field_key: "licencia_conducir", field_value: "si", confidence: 0.85 },
        // Injected fields — should be ignored for status determination.
        { field_key: "status", field_value: "cerrado", confidence: 1.0 },
        { field_key: "case_status", field_value: "listo", confidence: 1.0 },
      ],
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
    });

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    // Verify status was never set to cerrado or procesando.
    for (const args of capturedUpdateArgs) {
      expect(args.status).not.toBe("cerrado");
      expect(args.status).not.toBe("procesando");
      expect(["listo", "esperando", "escalado"]).toContain(args.status);
    }
  });

  // ── AI output invalid → escalado ───────────────────────────────────────────

  it("escalates to escalado when extractor throws OpenAIExtractionError", async () => {
    process.env.MOCK_AI = "false";
    process.env.OPENAI_API_KEY = "fake-key";

    const { OpenAIExtractionError } = await import("@/server/ai/openai-extractor");
    mockRunOpenAIExtractor.mockRejectedValue(
      new OpenAIExtractionError("AI output invalid after retry")
    );

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    const statusUpdates = capturedUpdateArgs.map((a) => a.status);
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

    // Raw email text should never appear in logs.
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

    const statusUpdates = capturedUpdateArgs.map((a) => a.status);
    expect(statusUpdates).toContain("escalado");
    expect(mockRunMockExtractor).not.toHaveBeenCalled();
  });

  // ── Case not in procesando → skip ─────────────────────────────────────────

  it("skips worker if case is not in procesando status", async () => {
    const { createServiceClient } = await import("@/lib/supabase/service");
    vi.mocked(createServiceClient).mockReturnValue(
      buildServiceMock({ ...MOCK_CASE_DATA, status: "listo" }) as unknown as ReturnType<typeof createServiceClient>
    );

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    expect(mockRunMockExtractor).not.toHaveBeenCalled();
  });

  // ── FSM validation ─────────────────────────────────────────────────────────

  it("FSM: procesando can only transition to listo, esperando, or escalado", async () => {
    mockRunMockExtractor.mockReturnValue(choqueAllFields(0.85));

    await runExtractionWorker("case-001", "tenant-001", "user-001");

    const ALLOWED = new Set(["listo", "esperando", "escalado"]);
    for (const args of capturedUpdateArgs) {
      if (args.status !== undefined) {
        expect(ALLOWED.has(String(args.status))).toBe(true);
      }
    }
  });
});
