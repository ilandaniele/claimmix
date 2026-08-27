/**
 * Una respuesta cortada por el tope de tokens no es una respuesta.
 *
 * Gemini avisa con `finishReason: "MAX_TOKENS"` cuando se queda sin lugar. El
 * HTTP sigue siendo 200 y el cuerpo trae el texto hasta donde llegó, así que
 * durante meses eso se devolvió como si estuviera completo: aguas abajo se
 * parseaba el JSON parcial y los campos que no habían llegado simplemente no
 * estaban. Nadie se enteraba.
 *
 * En producción pasa en el 2% de las extracciones —71 de 3.627— y el promedio
 * de salida es 1.497 tokens, así que las que tocan 8.192 no son respuestas
 * largas: son respuestas que se fueron de largo.
 *
 * Lo que se veía en su lugar era el sistema pidiéndole al asegurado algo que
 * acababa de decir:
 *
 *     👤 Soy Roberto Paz, DNI 25.888.101
 *     🤖 ¡Gracias, Roberto! Necesitamos que nos envíes:
 *        • Tu nombre y apellido completo.
 *
 * El modelo leyó el nombre —lo usa en el saludo— pero el JSON se cortó antes de
 * guardarlo, y el análisis de faltantes lo seguía contando como faltante. Salió
 * en el ensayo dos corridas seguidas, que es lo que lo separó de la variación
 * del modelo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const originalFetch = globalThis.fetch;
const guardadas: Record<string, string | undefined> = {};

/** Una respuesta de Gemini como la devuelve la API, con el motivo de corte. */
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

beforeEach(() => {
  for (const k of ["GEMINI_TRANSPORT", "GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT"]) {
    guardadas[k] = process.env[k];
  }
  // Por AI Studio, que es el camino que no necesita cuenta de servicio.
  process.env.GEMINI_TRANSPORT = "";
  process.env.GEMINI_API_KEY = "clave-de-prueba";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(guardadas)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("callGemini con la respuesta cortada", () => {
  it("rompe cuando el motivo de corte es MAX_TOKENS", async () => {
    globalThis.fetch = vi.fn(async () =>
      // JSON partido al medio: exactamente lo que llega cuando se acaba el lugar.
      respuesta("MAX_TOKENS", '{"is_claim":true,"fields":[{"field_key":"dni","field_v')
    ) as unknown as typeof fetch;

    const { callGemini } = await import("@/server/ai/gemini-extractor");
    await expect(callGemini("sistema", "usuario")).rejects.toThrow(/MAX_TOKENS/);
  });

  it("el error dice que fue el tope y no otra cosa", async () => {
    globalThis.fetch = vi.fn(async () => respuesta("MAX_TOKENS", "{")) as unknown as typeof fetch;

    const { callGemini } = await import("@/server/ai/gemini-extractor");
    const error = await callGemini("sistema", "usuario").catch((e: Error) => e);

    // Quien lo lea en un registro tiene que poder distinguirlo de un 500 o de
    // una clave vencida, que se arreglan de maneras distintas.
    expect((error as Error).message).toMatch(/tope de tokens/);
  });

  it("una respuesta que termina bien pasa como siempre", async () => {
    // La otra mitad, y la que evita que esto se convierta en un extractor que
    // no acepta nada: STOP es el final normal.
    globalThis.fetch = vi.fn(async () =>
      respuesta("STOP", '{"is_claim":true,"fields":[]}')
    ) as unknown as typeof fetch;

    const { callGemini } = await import("@/server/ai/gemini-extractor");
    const { text } = await callGemini("sistema", "usuario");
    expect(text).toContain("is_claim");
  });

  it("y una sin motivo de corte también, porque no todas lo traen", async () => {
    globalThis.fetch = vi.fn(async () =>
      respuesta(undefined, '{"is_claim":false,"fields":[]}')
    ) as unknown as typeof fetch;

    const { callGemini } = await import("@/server/ai/gemini-extractor");
    const { text } = await callGemini("sistema", "usuario");
    expect(text).toContain("is_claim");
  });
});
