/**
 * Toda llamada al modelo deja su consumo en `ai_usage`.
 *
 * `recordUsage` existe desde el principio y la única que lo llamaba era la
 * extracción. Todo lo demás que habla con Gemini no dejaba rastro:
 * `deliberate` hace hasta cuatro llamadas por mensaje entrante, `composeReply`
 * hasta dos, y reconocer un adjunto una por archivo —ésa mandando la foto
 * entera adentro del prompt—. Contra una o dos de extracción, que eran las
 * únicas que se anotaban: la tabla veía entre un cuarto y un tercio del gasto.
 *
 * No es contabilidad de adorno. Los tres topes de gasto leen esa tabla, así
 * que el techo no cortaba cuando tenía que cortar; y `/api/admin/billing`
 * calcula el costo de IA y el MARGEN con ella, así que el margen que muestra
 * la pantalla es sistemáticamente alto.
 *
 * Se afirma sobre la FILA que se inserta y no sobre una llamada espiada: el
 * helper llama a `recordUsage` por referencia interna al módulo, así que un
 * espía sobre el export no la vería — y una prueba que no ve lo que quiere
 * comprobar es peor que ninguna.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/** Las filas que se escribieron en `ai_usage` durante la prueba. */
const filas: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        filas.push(v);
        return Promise.resolve([]);
      },
    }),
  },
  tables: { aiUsage: "ai_usage" },
}));

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_c: unknown, armar: (d: unknown) => unknown) => Promise.resolve(armar(mod.db)),
  };
});

import { registrarConsumoDelModelo, computeCostUsd } from "@/server/ai/budget";

const INQUILINO = "10000000-0000-0000-0000-000000000001";

beforeEach(() => {
  filas.length = 0;
});

describe("registrarConsumoDelModelo", () => {
  it("escribe la fila con el inquilino, el modelo y los tokens", async () => {
    await registrarConsumoDelModelo(INQUILINO, "gemini-2.5-flash", {
      promptTokens: 1000,
      completionTokens: 500,
    });

    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      tenant_id: INQUILINO,
      model: "gemini-2.5-flash",
      prompt_tokens: 1000,
      completion_tokens: 500,
    });
  });

  it("no le atribuye el gasto a ninguna persona", async () => {
    // Estas llamadas las dispara un mensaje que entró por el webhook, no
    // alguien sentado en la aplicación: `null` es la verdad. El cupo por
    // usuario no las cuenta; el del inquilino y el mensual, sí, que es donde
    // faltaban.
    await registrarConsumoDelModelo(INQUILINO, "gemini-2.5-flash", {
      promptTokens: 10,
      completionTokens: 10,
    });

    expect(filas[0].user_id).toBeNull();
  });

  it("cobra con el precio del modelo que se usó, no con otro", async () => {
    // `ratesFor` cobra POR NOMBRE: un nombre que no coincide cae al precio de
    // otro modelo y el costo sale a la mitad. Un tope en dólares calculado con
    // el precio equivocado es la misma clase de defecto que un costo en cero,
    // con más pasos. Por eso `callGemini` ahora devuelve el modelo que usó.
    await registrarConsumoDelModelo(INQUILINO, "gemini-2.5-flash", {
      promptTokens: 1_000_000,
      completionTokens: 0,
    });

    const esperado = computeCostUsd(1_000_000, 0, "gemini-2.5-flash");
    expect(filas[0].cost_usd).toBe(esperado.toFixed(4));
    expect(esperado).toBeGreaterThan(0);
  });

  it("una llamada sin tokens no escribe una fila vacía", async () => {
    // Gemini omite `usageMetadata` a veces, y las pruebas que lo simulan
    // devuelven `usage: {}`. Una fila de ceros no suma nada y ensucia la tabla
    // que miran los topes.
    await registrarConsumoDelModelo(INQUILINO, "gemini-2.5-flash", {});
    await registrarConsumoDelModelo(INQUILINO, "gemini-2.5-flash", undefined);

    expect(filas).toHaveLength(0);
  });

  it("normaliza lo que viene incompleto en vez de meter undefined al INSERT", async () => {
    // `undefined <= 0` es false, así que sin normalizar acá entrarían tokens
    // `undefined` a la columna.
    await registrarConsumoDelModelo(INQUILINO, "gemini-2.5-flash", { promptTokens: 700 });

    expect(filas[0].prompt_tokens).toBe(700);
    expect(filas[0].completion_tokens).toBe(0);
  });
});
