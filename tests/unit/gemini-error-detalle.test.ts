/**
 * Un 429 sin el mensaje de Google no dice qué cuota se agotó.
 *
 * El cuerpo del error trae en `error.message` cuál límite se pasó — RPM,
 * TPM, cuota diaria — y hasta acá se leía sólo `error.status`
 * (RESOURCE_EXHAUSTED), que es el mismo para las tres. El próximo rojo por
 * 429 se diagnostica en el log, no reconstruyendo la corrida.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const originalFetch = globalThis.fetch;
const guardadas: Record<string, string | undefined> = {};

function respuesta429(body: unknown) {
  return {
    ok: false,
    status: 429,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  for (const k of [
    "GEMINI_TRANSPORT",
    "GEMINI_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GEMINI_MAX_RETRIES",
    "GEMINI_RETRY_BASE_MS",
    "GEMINI_MIN_REQUEST_INTERVAL_MS",
  ]) {
    guardadas[k] = process.env[k];
  }
  // Por AI Studio, que es el camino que no necesita cuenta de servicio.
  process.env.GEMINI_TRANSPORT = "";
  process.env.GEMINI_API_KEY = "clave-de-prueba";
  // Sin reintentos: un 429 es retryable y si no se apaga el bucle, el test
  // espera de más por cada intento.
  process.env.GEMINI_MAX_RETRIES = "0";
  process.env.GEMINI_RETRY_BASE_MS = "0";
  process.env.GEMINI_MIN_REQUEST_INTERVAL_MS = "0";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(guardadas)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("callGemini con un 429", () => {
  it("el error trae el mensaje de Google, que nombra la cuota", async () => {
    globalThis.fetch = vi.fn(async () =>
      respuesta429({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message:
            "Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model with limit 60",
        },
      })
    ) as unknown as typeof fetch;

    const { callGemini } = await import("@/server/ai/gemini-extractor");
    const error = await callGemini("sistema", "usuario").catch((e: Error) => e);

    expect((error as Error).message).toMatch(/^Gemini API error 429 RESOURCE_EXHAUSTED/);
    expect((error as Error).message).toContain(
      "generate_content_requests_per_minute_per_project_per_base_model"
    );
  });

  it("sin mensaje del lado de Google, el error queda como antes", async () => {
    globalThis.fetch = vi.fn(async () =>
      respuesta429({ error: { status: "RESOURCE_EXHAUSTED" } })
    ) as unknown as typeof fetch;

    const { callGemini } = await import("@/server/ai/gemini-extractor");
    const error = await callGemini("sistema", "usuario").catch((e: Error) => e);

    expect((error as Error).message).toBe("Gemini API error 429 RESOURCE_EXHAUSTED");
  });
});
