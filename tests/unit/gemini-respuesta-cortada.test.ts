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

/**
 * Y el reintento, que le daba el consejo equivocado.
 *
 * `extractEmailClaim` reintenta una vez con una corrección pegada al prompt.
 * La corrección decía SIEMPRE «tu respuesta anterior fue JSON inválido», sin
 * mirar por qué había fallado — y el código ya lo sabe, lo guarda en
 * `lastErrMeta`.
 *
 * Con MAX_TOKENS eso es un consejo correcto para otro problema: la respuesta
 * se cortó por LARGA y se le pedía que devolviera JSON válido. El modelo
 * volvía a escribir de más y el segundo intento fallaba igual que el primero.
 *
 * Pasó en el ensayo del 2026-09-08, dos corridas seguidas: los dos intentos
 * MAX_TOKENS, el caso a `escalado` y la persona sin ninguna respuesta. Y no es
 * raro — el encabezado de este archivo lo mide: 71 de 3.627 extracciones en
 * producción, un 2%.
 *
 * Lo que esto NO promete es que el segundo intento entre. El modelo puede
 * volver a pasarse. Lo que arregla es que la corrección hable del problema que
 * hubo.
 */
describe("el reintento dice qué salió mal", () => {
  /** Los prompts de sistema de cada llamada, en orden. */
  function espiarPrompts(finishReasons: Array<string | undefined>) {
    const prompts: string[] = [];
    let i = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body);
      prompts.push(body.systemInstruction?.parts?.[0]?.text ?? "");
      const motivo = finishReasons[Math.min(i, finishReasons.length - 1)];
      i += 1;
      return respuesta(motivo, '{"is_claim":true,"fields":[]}');
    }) as unknown as typeof fetch;
    return prompts;
  }

  it("con MAX_TOKENS le dice que se pasó de largo, no que el JSON estaba mal", async () => {
    const prompts = espiarPrompts(["MAX_TOKENS", "STOP"]);

    const { extractEmailClaimGemini } = await import("@/server/ai/gemini-extractor");
    await extractEmailClaimGemini({
      subject: "choque",
      body: "Tuve un choque ayer.",
      memoryHints: [],
      knownPatterns: [],
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("exceeded the length limit");
    expect(prompts[1]).toContain("Be concise");
    // Y NO el consejo de la otra falla, que es el que estaba antes.
    expect(prompts[1]).not.toContain("was invalid JSON");
  });

  it("con JSON inválido sigue diciendo lo de siempre", async () => {
    // La corrección vieja no se va: sigue siendo la correcta para su falla.
    const prompts: string[] = [];
    let i = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body);
      prompts.push(body.systemInstruction?.parts?.[0]?.text ?? "");
      const texto = i === 0 ? "esto no es json" : '{"is_claim":true,"fields":[]}';
      i += 1;
      return respuesta("STOP", texto);
    }) as unknown as typeof fetch;

    const { extractEmailClaimGemini } = await import("@/server/ai/gemini-extractor");
    await extractEmailClaimGemini({
      subject: "choque",
      body: "Tuve un choque ayer.",
      memoryHints: [],
      knownPatterns: [],
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("was invalid JSON");
    expect(prompts[1]).not.toContain("exceeded the length limit");
  });
});
