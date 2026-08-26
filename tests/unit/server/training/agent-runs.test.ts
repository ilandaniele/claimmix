import { beforeEach, describe, expect, it, vi } from "vitest";

const { captured, mockDbInsert } = vi.hoisted(() => ({
  captured: { row: null as Record<string, unknown> | null },
  mockDbInsert: vi.fn(),
}));

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: hay tests que
// intercambian la base simulada entre casos, y un `const { db } = ...`
// congelaría el valor de la primera.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: mockDbInsert,
  },
  tables: {
    agentRuns: {
      id: "id",
    },
  },
}));

vi.mock("@/lib/db/helpers", () => ({
  firstRow: <T>(rows: T[]): T | null => rows[0] ?? null,
}));

import { logAgentRun, logAgentRunError } from "@/server/training/agent-runs";

describe("logAgentRun", () => {
  beforeEach(() => {
    captured.row = null;
    mockDbInsert.mockReturnValue({
      values: vi.fn((row: Record<string, unknown>) => {
        captured.row = row;
        return {
          returning: vi.fn().mockResolvedValue([{ id: "run-001" }]),
        };
      }),
    });
  });

  it("stores gemini as the model_provider for Gemini extraction models", async () => {
    const id = await logAgentRun({
      tenantId: "tenant-001",
      caseId: "case-001",
      modelName: "gemini-2.5-flash",
      promptVersion: "builtin-v1",
      input: {
        subject: "Siniestro",
        body: "Tuve un choque.",
      },
      claim: {
        extraction_model: "gemini-2.5-flash",
        is_claim: true,
        confidence: 0.9,
        fields: [
          {
            field_key: "claim_type",
            field_value: "choque",
            confidence: 0.95,
            source: "ai",
          },
        ],
        missing_fields: [],
      } as any,
      trainability: {
        isTrainableSuggestion: true,
        trainabilityScore: 0.85,
        trainabilityReasons: [],
        blockingReasons: [],
      },
    });

    expect(id).toBe("run-001");
    expect(captured.row).toMatchObject({
      model_provider: "gemini",
      model_name: "gemini-2.5-flash",
    });
  });
});

describe("logAgentRunError", () => {
  beforeEach(() => {
    captured.row = null;
    mockDbInsert.mockReturnValue({
      values: vi.fn((row: Record<string, unknown>) => {
        captured.row = row;
        return {
          returning: vi.fn().mockResolvedValue([{ id: "err-run-001" }]),
        };
      }),
    });
  });

  it("always sets is_trainable_suggestion to false", async () => {
    await logAgentRunError({
      tenantId: "tenant-001",
      caseId: "case-001",
      input: { subject: "Siniestro", body: "Error de proveedor." },
      errorName: "GeminiExtractionError",
    });

    expect(captured.row).toMatchObject({ is_trainable_suggestion: false });
  });

  it("sets blocking_reasons to [\"provider_error\"]", async () => {
    await logAgentRunError({
      tenantId: "tenant-001",
      caseId: "case-001",
      input: { subject: "Siniestro", body: "Error de proveedor." },
      errorName: "GeminiExtractionError",
    });

    expect(captured.row).toMatchObject({ blocking_reasons: ["provider_error"] });
  });

  it("always records model_provider as gemini", async () => {
    await logAgentRunError({
      tenantId: "tenant-001",
      caseId: "case-001",
      input: { subject: "Siniestro", body: "Error de proveedor." },
      errorName: "GeminiExtractionError",
    });

    expect(captured.row).toMatchObject({ model_provider: "gemini" });
  });

  it("stores error name in output_payload", async () => {
    await logAgentRunError({
      tenantId: "tenant-001",
      caseId: "case-001",
      input: { subject: "Siniestro", body: "Error de proveedor." },
      errorName: "GeminiExtractionError",
    });

    expect((captured.row?.output_payload as Record<string, unknown>)?.error).toBe("provider_error");
    expect((captured.row?.output_payload as Record<string, unknown>)?.error_name).toBe("GeminiExtractionError");
  });

  it("stores the email input payload for later audit", async () => {
    await logAgentRunError({
      tenantId: "tenant-001",
      caseId: "case-err-42",
      input: { subject: "Choque", body: "Me chocaron ayer.", sender_email: "test@example.com" },
      errorName: "GeminiExtractionError",
    });

    expect(captured.row?.input_payload).toMatchObject({
      subject: "Choque",
      body: "Me chocaron ayer.",
      sender_email: "test@example.com",
    });
    expect(captured.row?.case_id).toBe("case-err-42");
  });

  it("returns the new row id on success", async () => {
    const id = await logAgentRunError({
      tenantId: "tenant-001",
      caseId: "case-001",
      input: { subject: "S", body: "B" },
      errorName: "GeminiExtractionError",
    });

    expect(id).toBe("err-run-001");
  });

  it("returns null gracefully when the DB insert throws", async () => {
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error("DB connection error")),
      }),
    });

    const id = await logAgentRunError({
      tenantId: "tenant-001",
      caseId: "case-001",
      input: { subject: "S", body: "B" },
      errorName: "GeminiExtractionError",
    });

    expect(id).toBeNull();
  });

  it("returns null silently on 42P01 (table not yet migrated)", async () => {
    const pgErr = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(pgErr),
      }),
    });

    const id = await logAgentRunError({
      tenantId: "tenant-001",
      caseId: "case-001",
      input: { subject: "S", body: "B" },
      errorName: "GeminiExtractionError",
    });

    expect(id).toBeNull();
  });
});
