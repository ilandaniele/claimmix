/**
 * Una llamada al modelo que no vuelve tiene un plazo.
 *
 * `fetch` iba sin `AbortSignal`. El default de undici son 300 s — cinco veces
 * el `maxDuration` de 60 s que `vercel.json` le da al webhook y al worker. O
 * sea que Vercel mataba la función ANTES de que el `catch` que escala el caso
 * llegara a correr: Vertex acepta la conexión, se queda callado, y el caso
 * queda como estaba, la persona sin respuesta y sin una línea que lo diga.
 *
 * El valor —20 s— no es 60/3. Es unas dos veces la llamada sana más lenta que
 * hay medida: 23 extracciones reales del ensayo del 2026-08-20, la más rápida
 * 3,0 s, la mediana 6,5 s, la más lenta 9,0 s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fetchOriginal = globalThis.fetch;
const guardadas: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["GEMINI_TRANSPORT", "GEMINI_API_KEY", "GEMINI_TIMEOUT_MS"]) {
    guardadas[k] = process.env[k];
  }
  process.env.GEMINI_TRANSPORT = "";
  process.env.GEMINI_API_KEY = "clave-de-prueba";
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  for (const [k, v] of Object.entries(guardadas)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("el transporte del modelo corta por tiempo", () => {
  it("le pasa una señal al fetch", async () => {
    // Lo que importa: que la petición lleve `signal`. Sin eso, no hay corte
    // posible y el resto de esta prueba no tendría sentido.
    let init: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_u: unknown, i: unknown) => {
      init = i as RequestInit;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { callGemini } = await import("@/server/ai/gemini-extractor");
    await callGemini("sistema", "usuario");

    expect(init?.signal).toBeDefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("un modelo que no contesta rompe con TIMEOUT, y rápido", async () => {
    // Con el plazo en 50 ms, un servidor que no contesta nunca tiene que
    // rendirse enseguida. Sin señal esto colgaría hasta que lo mate el runner.
    process.env.GEMINI_TIMEOUT_MS = "50";

    globalThis.fetch = vi.fn(
      (_u: unknown, i: unknown) =>
        new Promise((_resolve, reject) => {
          const señal = (i as RequestInit).signal;
          señal?.addEventListener("abort", () => reject((señal as AbortSignal).reason));
        })
    ) as unknown as typeof fetch;

    const { callGemini } = await import("@/server/ai/gemini-extractor");
    const arrancó = Date.now();
    const error = await callGemini("sistema", "usuario").catch((e: Error) => e);
    const tardó = Date.now() - arrancó;

    // El code viaja en `cause`, que es donde `errMeta` lo lee.
    expect((error as { cause?: { code?: string } }).cause?.code).toBe("TIMEOUT");
    // Y no se reintentó cuatro veces: 4 × 50 ms más los backoffs se notaría.
    expect(tardó).toBeLessThan(1_000);
  });

  it("el corte NO se reintenta como un socket caído", async () => {
    // Una conexión que se cae falla en milisegundos y reintentarla sale gratis
    // — eso justifica el bucle. Esperar el plazo cuatro veces son 80 s contra
    // una función de 60: el reintento garantizaría lo que el corte evita.
    process.env.GEMINI_TIMEOUT_MS = "30";

    let llamadas = 0;
    globalThis.fetch = vi.fn(
      (_u: unknown, i: unknown) =>
        new Promise((_resolve, reject) => {
          llamadas += 1;
          const señal = (i as RequestInit).signal;
          señal?.addEventListener("abort", () => reject((señal as AbortSignal).reason));
        })
    ) as unknown as typeof fetch;

    const { callGemini } = await import("@/server/ai/gemini-extractor");
    await callGemini("sistema", "usuario").catch(() => undefined);

    expect(llamadas).toBe(1);
  });

  it("en 0 no corta nada, para el ensayo y para una emergencia", async () => {
    process.env.GEMINI_TIMEOUT_MS = "0";

    let init: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_u: unknown, i: unknown) => {
      init = i as RequestInit;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { callGemini } = await import("@/server/ai/gemini-extractor");
    await callGemini("sistema", "usuario");

    expect(init?.signal).toBeUndefined();
  });
});
