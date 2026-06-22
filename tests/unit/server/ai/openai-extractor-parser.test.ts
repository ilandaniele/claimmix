import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/server/ai/budget", () => ({
  computeCostUsd: vi.fn(() => 0),
  recordUsage: vi.fn(),
}));

vi.mock("@/server/ai/provider", () => ({
  getDefaultOpenAIModel: vi.fn(() => "gpt-4o-mini"),
  getTenantOpenAIModel: vi.fn(async () => "gpt-4o-mini"),
}));

import {
  extractJsonObjectText,
  extractJsonObjectTexts,
  parseEmailResponse,
  parseResponse,
} from "@/server/ai/openai-extractor";

function validExtraction() {
  return {
    fields: [],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    is_claim: true,
    confidence: 0.92,
    extracted_fields: {
      full_name: "Juan Perez",
      email: "",
      phone: "",
      dni: "12345678",
      policy_number: "POL-123456",
      accident_date: "",
      accident_location: "",
      accident_description: "Choque leve",
      claim_type: "choque",
    },
    field_confidences: {},
    missing_fields: [],
    fields_pending_confirmation: [],
    possible_customer_matches: [],
    possible_policy_matches: [],
    severity: "medium",
    requires_specialist: false,
    not_relevant_reason: "",
    summary: "Choque leve",
    suggested_reply: "",
  };
}

describe("model JSON parser", () => {
  it("extracts the first balanced JSON object from prose", () => {
    const content = `Thinking done.\n${JSON.stringify(validExtraction())}\nThanks`;
    expect(extractJsonObjectText(content)).toBe(JSON.stringify(validExtraction()));
  });

  it("extracts multiple JSON object candidates from a noisy response", () => {
    const reasoning = { step: "checking if this is a claim" };
    const content = `${JSON.stringify(reasoning)}\n${JSON.stringify(validExtraction())}`;
    expect(extractJsonObjectTexts(content)).toHaveLength(2);
  });

  it("parses fenced Gemini JSON output", () => {
    const content = `\`\`\`json\n${JSON.stringify(validExtraction())}\n\`\`\``;
    const parsed = parseEmailResponse(content, "gemini-2.5-flash");
    expect(parsed?.is_claim).toBe(true);
    expect(parsed?.extraction_model).toBe("gemini-2.5-flash");
  });

  it("parses simulate output when JSON has leading text", () => {
    const parsed = parseResponse(
      `Aqui esta:\n${JSON.stringify(validExtraction())}`,
      "choque",
      "gemini-2.5-flash"
    );
    expect(parsed?.extracted_fields?.claim_type).toBe("choque");
  });

  it("skips invalid leading JSON and parses the final email extraction", () => {
    const content = `${JSON.stringify({ thinking: "not the schema" })}\n${JSON.stringify(validExtraction())}`;
    const parsed = parseEmailResponse(content, "gemini-2.5-flash");
    expect(parsed?.is_claim).toBe(true);
    expect(parsed?.extraction_model).toBe("gemini-2.5-flash");
  });

  it("skips invalid leading JSON and parses the final simulate extraction", () => {
    const content = `${JSON.stringify({ reasoning: { likely_claim: true } })}\n${JSON.stringify(validExtraction())}`;
    const parsed = parseResponse(content, "choque", "gemini-2.5-flash");
    expect(parsed?.extracted_fields?.claim_type).toBe("choque");
  });
});
