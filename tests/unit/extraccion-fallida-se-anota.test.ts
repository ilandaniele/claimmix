/**
 * Un intento fallido que Google ya cobró también se anota en `ai_usage`.
 *
 * `extractEmailClaimGemini` sólo grababa consumo cuando el segundo intento
 * terminaba en un `result`. Un MAX_TOKENS o un JSON inválido en los dos
 * intentos tira sin grabar nada — pero Google ya facturó esos tokens: el
 * tope mensual en dólares y el cupo diario por usuario los ven venir con un
 * paso de retraso. E14 hace que cualquier intento que Google haya cobrado
 * cuente, haya o no terminado en una extracción.
 *
 * Sólo TIMEOUT sigue sin grabar nada, porque ahí Google no llegó a contestar.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockRecordUsage } = vi.hoisted(() => ({ mockRecordUsage: vi.fn() }));

vi.mock("@/server/ai/budget", () => ({ computeCostUsd: vi.fn(() => 0.5), recordUsage: mockRecordUsage }));
vi.mock("@/server/ai/provider", () => ({
  getDefaultGeminiModel: () => "gemini-2.5-flash",
  getTenantGeminiModel: async () => "gemini-2.5-flash",
  getTenantGeminiKey: async () => null,
}));
vi.mock("@/server/ai/provider-usage", () => ({ logProviderUsage: vi.fn() }));

import { extractEmailClaimGemini } from "@/server/ai/gemini-extractor";

const TENANT = "10000000-0000-0000-0000-000000000001";
const USER = "20000000-0000-0000-0000-000000000001";

const guardadas: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

/** Misma forma que en gemini-respuesta-cortada.test.ts: 10000/8192 de uso. */
function respuesta(finishReason: string | undefined, texto: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: { parts: [{ text: texto }] },
          ...(finishReason ? { finishReason } : {}),
        },
      ],
      usageMetadata: { promptTokenCount: 10000, candidatesTokenCount: 8192 },
    }),
  } as unknown as Response;
}

function errorHttp500() {
  return {
    ok: false,
    status: 500,
    headers: new Headers(),
    json: async () => ({ error: { status: "INTERNAL", message: "boom" } }),
  } as unknown as Response;
}

beforeEach(() => {
  for (const k of ["GEMINI_TRANSPORT", "GEMINI_API_KEY", "GEMINI_MAX_RETRIES"]) {
    guardadas[k] = process.env[k];
  }
  process.env.GEMINI_TRANSPORT = "";
  process.env.GEMINI_API_KEY = "clave-de-prueba";
  process.env.GEMINI_MAX_RETRIES = "0";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(guardadas)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.clearAllMocks();
});

describe("un intento cortado por MAX_TOKENS anota lo que Google cobró", () => {
  it("a) los dos intentos MAX_TOKENS: rechaza y graba una vez, 20000/16384", async () => {
    globalThis.fetch = vi.fn(async () =>
      respuesta("MAX_TOKENS", '{"is_claim":tr')
    ) as unknown as typeof fetch;

    const err = await extractEmailClaimGemini(
      { subject: "choque", body: "Tuve un choque ayer.", memoryHints: [], knownPatterns: [] },
      TENANT,
      "caso-1",
      USER
    ).catch((e) => e);

    expect((err as { cause?: { code?: string } }).cause?.code).toBe("MAX_TOKENS");
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(TENANT, USER, "gemini-2.5-flash", 20000, 16384, 0.5);
  });

  it("b) MAX_TOKENS y después éxito: resuelve con los tokens de los dos intentos", async () => {
    let intento = 0;
    globalThis.fetch = vi.fn(async () => {
      intento++;
      return intento === 1
        ? respuesta("MAX_TOKENS", '{"is_claim":tr')
        : respuesta("STOP", '{"is_claim":true,"fields":[]}');
    }) as unknown as typeof fetch;

    const result = await extractEmailClaimGemini(
      { subject: "choque", body: "Tuve un choque ayer.", memoryHints: [], knownPatterns: [] },
      TENANT,
      "caso-1",
      USER
    );

    expect(result.prompt_tokens).toBe(20000);
    expect(result.completion_tokens).toBe(16384);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(TENANT, USER, "gemini-2.5-flash", 20000, 16384, 0.5);
  });

  it("c) JSON inválido en los dos intentos: rechaza pero igual graba 20000/16384", async () => {
    globalThis.fetch = vi.fn(async () =>
      respuesta("STOP", "esto no es json")
    ) as unknown as typeof fetch;

    await expect(
      extractEmailClaimGemini(
        { subject: "choque", body: "Tuve un choque ayer.", memoryHints: [], knownPatterns: [] },
        TENANT,
        "caso-1",
        USER
      )
    ).rejects.toThrow();

    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(TENANT, USER, "gemini-2.5-flash", 20000, 16384, 0.5);
  });

  it("d) (control) un 500 de Google no cobró nada: no graba", async () => {
    globalThis.fetch = vi.fn(async () => errorHttp500()) as unknown as typeof fetch;

    await expect(
      extractEmailClaimGemini(
        { subject: "choque", body: "Tuve un choque ayer.", memoryHints: [], knownPatterns: [] },
        TENANT,
        "caso-1",
        USER
      )
    ).rejects.toThrow();

    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("e) (control) recordUsage falla: el error que sale es el de la extracción, no el de recordUsage", async () => {
    mockRecordUsage.mockRejectedValueOnce(new Error("db"));
    globalThis.fetch = vi.fn(async () =>
      respuesta("MAX_TOKENS", '{"is_claim":tr')
    ) as unknown as typeof fetch;

    const err = await extractEmailClaimGemini(
      { subject: "choque", body: "Tuve un choque ayer.", memoryHints: [], knownPatterns: [] },
      TENANT,
      "caso-1",
      USER
    ).catch((e) => e);

    expect((err as Error).message).not.toContain("db");
    expect((err as { cause?: { code?: string; provider_error?: boolean } }).cause?.code).toBe("MAX_TOKENS");
    expect((err as { cause?: { provider_error?: boolean } }).cause?.provider_error).toBe(true);
  });
});
