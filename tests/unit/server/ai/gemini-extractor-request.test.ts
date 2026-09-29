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
}));

import { callGemini, contarTokens, extractEmailClaimGemini } from "@/server/ai/gemini-extractor";

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
    const fetchMock = vi.fn(async (_url?: unknown, _init?: RequestInit) => {
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
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: unknown, ms?: number, ...args: unknown[]) => {
      sleptMs.push(ms as number);
      return origSetTimeout(fn as TimerHandler, 0, ...args);
    }) as unknown as typeof setTimeout);

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
    const fetchMock = vi.fn(async (_url?: unknown, _init?: RequestInit) => {
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

    const [url, init] = fetchMock.mock.calls[0]!;
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

describe("Gemini extractor transport — a connection that drops", () => {
  /**
   * The retry loop only ever looked at HTTP statuses. A socket that reset threw
   * straight out of fetch, past every retry, and the extraction failed — which
   * means a claimant's message went unanswered because of a network hiccup.
   * ECONNRESET and UND_ERR_CONNECT_TIMEOUT both appeared repeatedly in a single
   * afternoon of rehearsals against the real API.
   */
  function networkError(code: string): Error {
    const err = new TypeError("fetch failed");
    (err as unknown as { cause: { code: string } }).cause = { code };
    return err;
  }

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_MIN_REQUEST_INTERVAL_MS = "0";
    process.env.GEMINI_MAX_RETRIES = "2";
    process.env.GEMINI_RETRY_BASE_MS = "1";
  });

  afterEach(() => {
    delete process.env.GEMINI_RETRY_BASE_MS;
    vi.unstubAllGlobals();
  });

  it("tries again after a reset connection", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(networkError("ECONNRESET"))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => geminiJsonResponse(),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractEmailClaimGemini({
      subject: "Choque",
      body: "Choqué ayer en Bahía Blanca.",
      memoryHints: [],
      knownPatterns: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.is_claim).toBe(true);
  });

  it("tries again after a connect timeout", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(networkError("UND_ERR_CONNECT_TIMEOUT"))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => geminiJsonResponse(),
      });
    vi.stubGlobal("fetch", fetchMock);

    await extractEmailClaimGemini({
      subject: "Choque",
      body: "Choqué ayer.",
      memoryHints: [],
      knownPatterns: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up loudly rather than silently, once the attempts run out", async () => {
    // Silence here would be the worst outcome: the case sits in `procesando`
    // and nobody knows the model was never reached.
    const fetchMock = vi.fn().mockRejectedValue(networkError("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      extractEmailClaimGemini({
        subject: "Choque",
        body: "Choqué ayer.",
        memoryHints: [],
        knownPatterns: [],
      })
    ).rejects.toThrow();

    // Six: three transport attempts (maxRetries=2), inside the extractor's own
    // two-attempt loop. Worth knowing the two are multiplied rather than
    // shared — a generous GEMINI_MAX_RETRIES costs twice what it looks like.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe("Gemini extractor — archivos adjuntos", () => {
  const media = [{ mimeType: "application/pdf", data: "JVBERi0=" }];

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_MIN_REQUEST_INTERVAL_MS = "0";
    process.env.GEMINI_MAX_RETRIES = "0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("cada archivo viaja entre centinelas <adjunto>, después del mensaje", async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(geminiJsonResponse()), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await extractEmailClaimGemini({ subject: "S", body: "B", memoryHints: [], knownPatterns: [], media });

    const parts = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).contents[0].parts;
    expect(parts.slice(1)).toEqual([
      { text: "<adjunto indice=1 mime=application/pdf>" },
      { inlineData: { mimeType: "application/pdf", data: "JVBERi0=" } },
      { text: "</adjunto>" },
    ]);
  });

  it("un mime armado para cerrar la etiqueta no la cierra", async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(geminiJsonResponse()), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await extractEmailClaimGemini({
      subject: "S", body: "B", memoryHints: [], knownPatterns: [],
      media: [{ mimeType: "image/png><x", data: "iVBO" }],
    });

    const parts = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).contents[0].parts;
    expect(parts[1].text).toBe("<adjunto indice=1 mime=image/pngx>");
  });

  it("con archivos, un TIMEOUT no se reintenta en la misma corrida", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      extractEmailClaimGemini({ subject: "S", body: "B", memoryHints: [], knownPatterns: [], media })
    ).rejects.toMatchObject({ cause: { code: "TIMEOUT" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("un 400 con archivos se reintenta sin ellos y no da lecturas de lo que no vio", async () => {
    const respuesta = geminiJsonResponse();
    const texto = JSON.parse(respuesta.candidates[0]!.content.parts[0]!.text);
    respuesta.candidates[0]!.content.parts[0]!.text = JSON.stringify({
      ...texto,
      adjuntos: [{ indice: 1, resumen: "Constancia.", util: true, documento: null }],
    });
    const fetchMock = vi
      .fn(async (_url?: unknown, _init?: RequestInit) => new Response(JSON.stringify(respuesta), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }), { status: 400 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const claim = await extractEmailClaimGemini({ subject: "S", body: "B", memoryHints: [], knownPatterns: [], media });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const segundo = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(JSON.stringify(segundo.contents)).not.toContain("inlineData");
    expect(JSON.stringify(segundo)).not.toContain("invalid JSON");
    expect(claim.adjuntos).toEqual([]);
  });
});

describe("callGemini — tokens de audio", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_MIN_REQUEST_INTERVAL_MS = "0";
    process.env.GEMINI_MAX_RETRIES = "0";
  });

  afterEach(() => vi.unstubAllGlobals());

  it("separa del total los tokens que entraron como audio", async () => {
    const r = geminiJsonResponse();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...r,
      usageMetadata: {
        promptTokenCount: 900,
        candidatesTokenCount: 50,
        promptTokensDetails: [{ modality: "TEXT", tokenCount: 300 }, { modality: "AUDIO", tokenCount: 600 }],
      },
    }), { status: 200 })));

    const { usage } = await callGemini("sys", "user", undefined, "gemini-2.5-flash", [{ mimeType: "audio/ogg", data: "T2dn" }]);
    expect(usage).toEqual({ promptTokens: 900, completionTokens: 50, audioTokens: 600 });
  });

  it("sin audio no agrega la clave", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(geminiJsonResponse()), { status: 200 })));
    const { usage } = await callGemini("sys", "user");
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });
});

describe("contarTokens", () => {
  const PDF = { mimeType: "application/pdf", data: "JVBERi0=" };

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
  });

  afterEach(() => vi.unstubAllGlobals());

  it("pide countTokens con el archivo y devuelve el total", async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ totalTokens: 2580 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await contarTokens(PDF, 1000)).toBe(2580);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/:countTokens$/);
    expect(JSON.parse(String(init?.body))).toEqual({ contents: [{ role: "user", parts: [{ inlineData: PDF }] }] });
  });

  it("\"plazo\" si no contesta a tiempo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("tarde", "TimeoutError");
    }));
    expect(await contarTokens(PDF, 1000)).toBe("plazo");
  });

  it("null si rechaza el archivo o se corta la red", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    expect(await contarTokens(PDF, 1000)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    expect(await contarTokens(PDF, 1000)).toBeNull();
  });
});
