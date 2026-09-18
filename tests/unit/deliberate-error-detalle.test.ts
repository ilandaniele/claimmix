/**
 * `deliberate.failed` con sólo `err.name` no distinguía un 429 de un
 * MAX_TOKENS: un ensayo verde trajo tres de estos con
 * `detalle: "GeminiExtractionError"` y nada que dijera cuál de los dos había
 * pasado. `errMeta` ya sabía sacar `status` y `code` de la causa — lo usaba
 * `gemini-extractor.ts` — y `deliberate.ts` no lo llamaba.
 *
 * Mismo montaje que gemini-error-detalle.test.ts: se deja correr el
 * `callGemini` real contra un `fetch` que devuelve 429, y se comprueba qué le
 * llega al logger.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));

vi.mock("@/lib/observability/logger", () => ({
  logger: { error: mockLogError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

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
  mockLogError.mockClear();
  for (const k of [
    "GEMINI_TRANSPORT",
    "GEMINI_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GEMINI_MAX_RETRIES",
    "GEMINI_RETRY_BASE_MS",
    "GEMINI_MIN_REQUEST_INTERVAL_MS",
    "AGENT_DELIBERATION",
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
  delete process.env.AGENT_DELIBERATION;

  globalThis.fetch = vi.fn(async () =>
    respuesta429({
      error: {
        status: "RESOURCE_EXHAUSTED",
        message: "Quota exceeded for generate_content_requests_per_minute",
      },
    })
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(guardadas)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

function situation() {
  return {
    caseId: "11111111-1111-1111-1111-111111111111",
    tenantId: "10000000-0000-0000-0000-000000000001",
    outstanding: ["policy_number"],
    knownValues: {},
    lastAsked: [],
    latestMessage: "choqué ayer",
    claimTypeLabel: "choque de vehículo",
    isHighSeverity: false,
    isComplete: false,
  };
}

describe("deliberate ante un 429 de Gemini", () => {
  it("resuelve null y el log trae status y code, no sólo el nombre", async () => {
    const { deliberate } = await import("@/server/ai/deliberate");

    const plan = await deliberate(situation());

    expect(plan).toBeNull();
    expect(mockLogError).toHaveBeenCalledTimes(1);

    const [payload, msg] = mockLogError.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("deliberate.failed");
    expect(payload.status).toBe(429);
    expect(payload.code).toBe("RESOURCE_EXHAUSTED");
  });
});
