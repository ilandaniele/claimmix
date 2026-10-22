import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/server/gcp/credenciales", () => ({
  tokenDeGcp: vi.fn(async () => "fake-vertex-token"),
}));

vi.mock("@/server/ai/budget", () => ({
  computeCostUsd: vi.fn(() => 0),
  recordUsage: vi.fn(),
}));

vi.mock("@/server/ai/provider", () => ({
  getDefaultGeminiModel: vi.fn(() => "gemini-flash-latest"),
  getTenantGeminiModel: vi.fn(async () => "gemini-flash-latest"),
  getTenantGeminiKey: vi.fn(async () => null),
}));

import { callGemini, esPasajero } from "@/server/ai/gemini-extractor";
import { tokenDeGcp } from "@/server/gcp/credenciales";

const VARIABLES = [
  "GEMINI_TRANSPORT",
  "GOOGLE_CLOUD_PROJECT",
  "VERTEX_EXTRACTION_MODEL",
  "VERTEX_EXTRACTION_LOCATION",
  "GOOGLE_CLOUD_LOCATION",
  "GEMINI_MIN_REQUEST_INTERVAL_MS",
  "GEMINI_MAX_RETRIES",
] as const;
const originales = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));

function respuesta(usageMetadata: Record<string, number> = { promptTokenCount: 10, candidatesTokenCount: 20 }) {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }], usageMetadata }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function pedido(fetchMock: ReturnType<typeof vi.fn>): { url: string; body: { generationConfig: Record<string, unknown> } } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) };
}

describe("extracción por Vertex con Gemini 3", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const v of VARIABLES) delete process.env[v];
    process.env.GEMINI_TRANSPORT = "vertex";
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    process.env.GEMINI_MIN_REQUEST_INTERVAL_MS = "0";
    process.env.GEMINI_MAX_RETRIES = "0";
    fetchMock = vi.fn(async () => respuesta());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const v of VARIABLES) {
      if (originales[v] === undefined) delete process.env[v];
      else process.env[v] = originales[v];
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sin variables usa gemini-3.8-flash en la multirregión us, con su propio host", async () => {
    const r = await callGemini("sistema", "mensaje");
    const { url } = pedido(fetchMock);
    expect(url).toBe(
      "https://aiplatform.us.rep.googleapis.com/v1/projects/test-project/locations/us/publishers/google/models/gemini-3.8-flash:generateContent"
    );
    expect(r.model).toBe("gemini-3.8-flash");
  });

  it("una región clásica sigue usando el host con prefijo", async () => {
    process.env.VERTEX_EXTRACTION_LOCATION = "us-central1";
    await callGemini("sistema", "mensaje");
    expect(pedido(fetchMock).url).toMatch(
      /^https:\/\/us-central1-aiplatform\.googleapis\.com\/v1\/projects\/test-project\/locations\/us-central1\//
    );
  });

  it("eu y global van a sus hosts", async () => {
    process.env.VERTEX_EXTRACTION_LOCATION = "eu";
    await callGemini("sistema", "mensaje");
    expect(pedido(fetchMock).url).toMatch(/^https:\/\/aiplatform\.eu\.rep\.googleapis\.com\/v1\/projects\/test-project\/locations\/eu\//);

    fetchMock.mockClear();
    process.env.VERTEX_EXTRACTION_LOCATION = "global";
    await callGemini("sistema", "mensaje");
    expect(pedido(fetchMock).url).toMatch(/^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/test-project\/locations\/global\//);
  });

  it("3.8-flash razona en LOW, sin thinkingBudget ni temperatura", async () => {
    await callGemini("sistema", "mensaje");
    const config = pedido(fetchMock).body.generationConfig;
    expect(config.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(config).not.toHaveProperty("temperature");
  });

  it("3.5-flash baja a MINIMAL", async () => {
    process.env.VERTEX_EXTRACTION_MODEL = "gemini-3.5-flash";
    await callGemini("sistema", "mensaje");
    const config = pedido(fetchMock).body.generationConfig;
    expect(config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    expect(config).not.toHaveProperty("temperature");
  });

  it("la retoma tras un corte no le baja la temperatura a Gemini 3", async () => {
    await callGemini("sistema", "mensaje", null, undefined, undefined, { temperature: 0.3 });
    expect(pedido(fetchMock).body.generationConfig).not.toHaveProperty("temperature");
  });

  it("2.5 sigue en su región, con el razonamiento apagado y la temperatura pedida", async () => {
    process.env.VERTEX_EXTRACTION_MODEL = "gemini-2.5-flash";
    await callGemini("sistema", "mensaje", null, undefined, undefined, { temperature: 0.3 });
    const { url, body } = pedido(fetchMock);
    expect(url).toContain("https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/");
    const config = body.generationConfig;
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(config.temperature).toBe(0.3);
  });

  it("los tokens de razonamiento se cuentan como salida", async () => {
    fetchMock.mockImplementation(async () =>
      respuesta({ promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 25 })
    );
    const r = await callGemini("sistema", "mensaje");
    expect(r.usage).toMatchObject({ promptTokens: 100, completionTokens: 65 });
  });

  it("un token que no se pudo pedir es pasajero: no hubo pedido que corregir", async () => {
    vi.mocked(tokenDeGcp).mockRejectedValueOnce(new Error("invalid_grant"));
    const err = await callGemini("sistema", "mensaje").catch((e: unknown) => e);
    expect(esPasajero(err)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
