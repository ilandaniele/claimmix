import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/server/ai/budget", () => ({
  computeCostUsd: vi.fn(() => 0),
  recordUsage: vi.fn(),
}));

vi.mock("@/server/ai/provider", () => ({
  getDefaultGeminiModel: vi.fn(() => "gemini-2.5-flash"),
  getTenantGeminiModel: vi.fn(async () => "gemini-2.5-flash"),
  getTenantGeminiKey: vi.fn(async () => null),
  getDefaultOpenAIModel: vi.fn(() => "gpt-4o-mini"),
  getTenantOpenAIModel: vi.fn(async () => "gpt-4o-mini"),
}));

import { extractEmailClaimGemini } from "@/server/ai/gemini-extractor";

const ORIGINAL_GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function geminiJsonResponse() {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                extraction_model: "gemini-2.5-flash",
                fields: [],
                prompt_tokens: 0,
                completion_tokens: 0,
                cost_usd: 0,
                is_claim: true,
                confidence: 0.95,
                extracted_fields: {
                  full_name: "Juan Perez",
                  dni: "12345678",
                  claim_type: "choque",
                  accident_description: "Choque leve",
                },
                field_confidences: {},
                missing_fields: [],
                fields_pending_confirmation: [],
                possible_customer_matches: [],
                possible_policy_matches: [],
                severity: "medium",
                requires_specialist: false,
                summary: "Choque leve",
                suggested_reply: "",
              }),
            },
          ],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
    },
  };
}

describe("Gemini extractor request", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_MIN_REQUEST_INTERVAL_MS = "0";
    process.env.GEMINI_MAX_RETRIES = "0";
  });

  afterEach(() => {
    if (ORIGINAL_GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_API_KEY;
    delete process.env.GEMINI_MIN_REQUEST_INTERVAL_MS;
    delete process.env.GEMINI_MAX_RETRIES;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("caps 429 retry wait at 10 seconds so function lifetime is not exceeded", async () => {
    // Arrange: Gemini returns 429 with retry-after: 3600 (daily quota exhausted)
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        return new Response(
          JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "retry-after": "3600", // 1 hour from Gemini
            },
          }
        );
      }
      return new Response(JSON.stringify(geminiJsonResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Track actual sleep durations
    const sleptMs: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
      sleptMs.push(ms as number);
      return origSetTimeout(fn as TimerHandler, 0, ...args);
    });

    // Allow 1 retry so the 429 path is exercised
    process.env.GEMINI_MAX_RETRIES = "1";

    try {
      await extractEmailClaimGemini({
        subject: "Siniestro",
        body: "Reclamo de prueba",
        memoryHints: [],
        knownPatterns: [],
      });
    } catch {
      // GeminiExtractionError is fine — we only care about sleep durations
    }

    // Any retry wait must be ≤ 10 000 ms regardless of the retry-after header
    for (const ms of sleptMs) {
      expect(ms).toBeLessThanOrEqual(10_000);
    }
  });

  it("requests Gemini JSON mode with the REST API field names", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(geminiJsonResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractEmailClaimGemini({
      subject: "Siniestro",
      body: "Tuve un choque leve y quiero iniciar el reclamo.",
      memoryHints: [],
      knownPatterns: [],
    });

    expect(result.is_claim).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/gemini-2.5-flash:generateContent");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-goog-api-key": "test-gemini-key",
    });

    const requestBody = JSON.parse(String(init?.body));
    expect(requestBody.generationConfig).toMatchObject({
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    });
    expect(requestBody.generationConfig).not.toHaveProperty("responseFormat");
    expect(requestBody.generationConfig).not.toHaveProperty("responseSchema");
  });
});
