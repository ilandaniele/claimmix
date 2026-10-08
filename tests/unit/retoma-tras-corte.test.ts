/**
 * La retoma de un caso que ya tuvo una extracción sin terminar sale concisa y
 * a 0,3.
 *
 * Con temperatura 0 el mismo prompt repite la misma secuencia: si el modelo se
 * desbocó la primera vez, la retoma se desboca igual y vuelve a cortar por
 * tiempo. La señal la arma el worker (`trasCorte`); acá se prueba lo que el
 * extractor hace con ella, y que sin ella el pedido sale como siempre.
 */
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

import { logger } from "@/lib/observability/logger";
import {
  CORRECCION_TRAS_CORTE,
  TEMPERATURA_TRAS_CORTE,
  callGemini,
  extractEmailClaimGemini,
} from "@/server/ai/gemini-extractor";

const ORIGINAL_GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const CORRECCION_MAX_TOKENS =
  "\n\nIMPORTANT: Your previous response was cut off because it exceeded the length limit. Be concise: emit each field once, do not repeat yourself, and omit fields you have no value for. Return ONLY valid JSON matching the schema.";

const CORRECCION_JSON_INVALIDO =
  "\n\nIMPORTANT: Your previous response was invalid JSON. Return ONLY valid JSON matching the schema exactly. No markdown, no code blocks, no extra text.";

const CORREO = {
  subject: "Siniestro",
  body: "Tuve un choque leve y quiero iniciar el reclamo.",
  memoryHints: [],
  knownPatterns: [],
};

function respuestaSana() {
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
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  };
}

/** Una respuesta de Gemini que no se puede leer como JSON, o cortada por el tope. */
function respuestaRota(texto: string, finishReason = "STOP") {
  return {
    candidates: [{ content: { parts: [{ text: texto }] }, finishReason }],
    usageMetadata: { promptTokenCount: 10000, candidatesTokenCount: 8192 },
  };
}

function http200(cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Arma un fetch que contesta en orden y deja a mano lo que se mandó. */
function fetchEnOrden(respuestas: Array<() => Response | Promise<Response>>) {
  let llamada = 0;
  const fetchMock = vi.fn(async (_url?: unknown, _init?: RequestInit) => {
    const i = Math.min(llamada++, respuestas.length - 1);
    return respuestas[i]!();
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    pedido: (n: number) => {
      const init = fetchMock.mock.calls[n]![1];
      const cuerpo = JSON.parse(String(init?.body));
      return {
        generationConfig: cuerpo.generationConfig as Record<string, unknown>,
        sistema: cuerpo.systemInstruction.parts[0].text as string,
      };
    },
  };
}

describe("la retoma tras un corte", () => {
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
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("el primer intento ya sale a 0,3 y con la corrección de concisión", async () => {
    const { fetchMock, pedido } = fetchEnOrden([() => http200(respuestaSana())]);
    const info = vi.spyOn(logger, "info");

    const r = await extractEmailClaimGemini({ ...CORREO, trasCorte: true }, "t-1", "c-1");

    expect(r.is_claim).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { generationConfig, sistema } = pedido(0);
    expect(generationConfig).toMatchObject({
      temperature: 0.3,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    });
    expect(TEMPERATURA_TRAS_CORTE).toBe(0.3);
    expect(sistema.endsWith(CORRECCION_TRAS_CORTE)).toBe(true);
    expect(sistema).toContain("did not finish in time");
    expect(sistema).toContain("Be concise");
    const avisos = info.mock.calls.filter(([, msg]) => msg === "ai.email_extraction.tras_corte");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]![0]).toEqual({ case_id: "c-1", tenant_id: "t-1" });
  });

  it("sin la señal el pedido sale como siempre: temperatura 0 y el prompt limpio", async () => {
    const { pedido } = fetchEnOrden([() => http200(respuestaSana())]);
    const info = vi.spyOn(logger, "info");

    await extractEmailClaimGemini(CORREO);

    const { generationConfig, sistema } = pedido(0);
    expect(generationConfig).toMatchObject({
      temperature: 0,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
    });
    expect(sistema).not.toContain("did not finish in time");
    expect(sistema).not.toContain("Be concise");
    expect(info.mock.calls.some(([, msg]) => msg === "ai.email_extraction.tras_corte")).toBe(false);
  });

  it("con trasCorte en false es lo mismo que sin ella", async () => {
    const { pedido } = fetchEnOrden([() => http200(respuestaSana())]);

    await extractEmailClaimGemini({ ...CORREO, trasCorte: false });

    expect(pedido(0).generationConfig.temperature).toBe(0);
    expect(pedido(0).sistema).not.toContain(CORRECCION_TRAS_CORTE);
  });

  it("si el primer intento no da JSON, el segundo también va a 0,3 y con las dos correcciones", async () => {
    const { fetchMock, pedido } = fetchEnOrden([
      () => http200(respuestaRota("esto no es json")),
      () => http200(respuestaSana()),
    ]);

    const r = await extractEmailClaimGemini({ ...CORREO, trasCorte: true });

    expect(r.is_claim).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pedido(1).generationConfig).toMatchObject({
      temperature: 0.3,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
    });
    expect(pedido(1).sistema).toContain(CORRECCION_TRAS_CORTE);
    expect(pedido(1).sistema.endsWith(CORRECCION_JSON_INVALIDO)).toBe(true);
  });

  it("un TIMEOUT sigue sin reintento dentro de la corrida, también con la señal", async () => {
    const { fetchMock } = fetchEnOrden([
      () => {
        throw Object.assign(new Error("se acabó el tiempo"), { name: "TimeoutError" });
      },
    ]);

    await expect(extractEmailClaimGemini({ ...CORREO, trasCorte: true })).rejects.toMatchObject({
      cause: { code: "TIMEOUT" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("MAX_TOKENS sin la señal conserva la corrección de siempre, letra por letra", async () => {
    const { pedido } = fetchEnOrden([
      () => http200(respuestaRota('{"is_claim":true,"fields":[{"field_key":"dni","field_v', "MAX_TOKENS")),
      () => http200(respuestaSana()),
    ]);

    await extractEmailClaimGemini(CORREO);

    expect(pedido(1).sistema.endsWith(CORRECCION_MAX_TOKENS)).toBe(true);
    expect(pedido(1).sistema).not.toContain(CORRECCION_TRAS_CORTE);
    expect(pedido(1).generationConfig.temperature).toBe(0);
  });

  it("callGemini sin el sexto argumento manda temperatura 0", async () => {
    const { pedido } = fetchEnOrden([() => http200(respuestaSana())]);

    await callGemini("sistema", "usuario");

    expect(pedido(0).generationConfig).toMatchObject({
      temperature: 0,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it("y con él, manda la que se le pide sin tocar el resto", async () => {
    const { pedido } = fetchEnOrden([() => http200(respuestaSana())]);

    await callGemini("sistema", "usuario", null, undefined, undefined, { temperature: 0.3 });

    expect(pedido(0).generationConfig).toMatchObject({
      temperature: 0.3,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    });
  });
});
