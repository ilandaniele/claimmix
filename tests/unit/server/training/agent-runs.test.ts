import { beforeEach, describe, expect, it, vi } from "vitest";

const { captured, mockDbInsert } = vi.hoisted(() => ({
  captured: { row: null as Record<string, unknown> | null },
  mockDbInsert: vi.fn(),
}));

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

import { logAgentRun } from "@/server/training/agent-runs";

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

  it("stores gemini as the model provider for Gemini extraction models", async () => {
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
