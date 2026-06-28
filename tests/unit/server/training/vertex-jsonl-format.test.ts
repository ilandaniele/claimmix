/**
 * Regression test for the Vertex AI Gemini supervised-tuning dataset format.
 *
 * tuningJob 9110414817876770816 (baseModel gemini-2.5-flash) FAILED with:
 *   "Converting from 'ChatCompletions' to 'GenerateContent' dataset format is
 *    currently not supported for this model."
 * because buildVertexAiJsonl emitted the OpenAI `{ messages: [{ role, content }] }`
 * shape. Vertex Gemini tuning requires the GenerateContent shape:
 *   { systemInstruction: { parts: [{ text }] }, contents: [{ role, parts: [{ text }] }] }
 *
 * These tests lock in the correct shape so the regression can't return silently.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: { select: mockSelect },
  tables: {
    trainingExamples: {
      id: "id",
      tenant_id: "tenant_id",
      input_payload: "input_payload",
      expected_output: "expected_output",
      created_at: "created_at",
      status: "status",
    },
  },
}));

import { buildVertexAiJsonl } from "@/server/training/vertex-ai-fine-tuning";

/** Mocks the db.select(...).from(...).where(...).orderBy(...).limit(...) chain. */
function mockApprovedRows(rows: Array<Record<string, unknown>>) {
  mockSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  });
}

const EXAMPLE = {
  id: "ex-1",
  tenant_id: "tenant-1",
  created_at: "2026-06-26T00:00:00Z",
  input_payload: { subject: "Siniestro choque", body: "Tuve un choque en Av. Corrientes." },
  expected_output: { agent_output: { is_claim: true, fields: [] }, confirmed_fields: [] },
};

describe("buildVertexAiJsonl — Vertex GenerateContent format", () => {
  beforeEach(() => {
    mockSelect.mockReset();
  });

  it("emits systemInstruction + contents, never the ChatCompletions `messages` shape", async () => {
    mockApprovedRows([EXAMPLE]);
    const out = await buildVertexAiJsonl("tenant-1");
    const line = out.trainingJsonl.trim().split("\n")[0];
    const parsed = JSON.parse(line);

    // Must NOT be the OpenAI ChatCompletions shape that Vertex rejects.
    expect(parsed.messages).toBeUndefined();

    // Must be the Vertex Gemini GenerateContent shape.
    expect(parsed.systemInstruction).toBeDefined();
    expect(parsed.systemInstruction.parts[0].text).toContain("ClaimMix");
    expect(Array.isArray(parsed.contents)).toBe(true);
  });

  it("uses user + model roles with parts[].text (not content)", async () => {
    mockApprovedRows([EXAMPLE]);
    const out = await buildVertexAiJsonl("tenant-1");
    const parsed = JSON.parse(out.trainingJsonl.trim().split("\n")[0]);

    const roles = parsed.contents.map((c: { role: string }) => c.role);
    expect(roles).toEqual(["user", "model"]);

    for (const turn of parsed.contents) {
      expect(turn.content).toBeUndefined();
      expect(typeof turn.parts[0].text).toBe("string");
      expect(turn.parts[0].text.length).toBeGreaterThan(0);
    }

    // The user turn carries the email; the model turn carries the JSON answer.
    expect(parsed.contents[0].parts[0].text).toContain("Siniestro choque");
    expect(() => JSON.parse(parsed.contents[1].parts[0].text)).not.toThrow();
  });
});
