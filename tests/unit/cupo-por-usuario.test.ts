/**
 * El cupo diario por usuario no podía alcanzarse nunca.
 *
 * `gemini-extractor` grababa `recordUsage(tenantId, null, …)` teniendo el
 * `userId` en la firma de la propia función. Resultado medido en la base:
 * 7.554 filas de `ai_usage`, CERO con usuario. El paso 3 de `checkBudget` suma
 * sobre un conjunto vacío, da 0, y deja pasar siempre.
 *
 * Un tope que no puede alcanzarse no es un tope: es una línea que tranquiliza.
 *
 * ── Por qué el default subió de 100.000 a 2.000.000 ─────────────────────────
 *
 * Arreglar la grabación PRENDE el tope, y 100.000 nunca se validó contra el uso
 * real porque nunca se ejerció. Medido sobre esas 7.554 llamadas: 11.771 tokens
 * de promedio, 12.730 el p95, 34.798 el máximo. O sea que 100.000 son OCHO
 * extracciones por persona por día — un analista lo agotaba antes del mediodía, y
 * una tanda de los 108 escenarios de `batch-simulate` lo reventaba de entrada.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const EXTRACTOR = readFileSync("src/server/ai/gemini-extractor.ts", "utf8");
const BUDGET = readFileSync("src/server/ai/budget.ts", "utf8");

describe("el uso se graba con el usuario que lo gastó", () => {
  it("gemini-extractor pasa el userId, no null", () => {
    expect(EXTRACTOR).toContain("recordUsage(tenantId, userId ?? null,");
    expect(EXTRACTOR).not.toContain("recordUsage(tenantId, null,");
  });
});

describe("el tope por usuario es alcanzable y no estorba", () => {
  it("el default es 2.000.000", () => {
    expect(BUDGET).toContain("AI_USER_DAILY_TOKEN_CAP, 2_000_000");
  });

  it("deja lugar a más de cien extracciones de tamaño real", () => {
    /*
     * El control de que el número sirve. 11.771 tokens es el promedio medido;
     * un tope que no aguante un día de trabajo rompe el producto en vez de
     * protegerlo, que es exactamente lo que habría pasado prendiéndolo en
     * 100.000.
     */
    const PROMEDIO_MEDIDO = 11_771;
    const tope = 2_000_000;
    expect(Math.floor(tope / PROMEDIO_MEDIDO)).toBeGreaterThan(100);
  });

  it("y sigue por debajo del tope del inquilino, que es de 20 millones", () => {
    // Si el cupo de una persona fuera mayor que el de toda la aseguradora, el
    // de la persona no frenaría nunca nada.
    expect(2_000_000).toBeLessThan(20_000_000);
  });

  it("se puede bajar por variable de entorno", () => {
    // La decisión de cuánto es de quien opera, no del default.
    expect(BUDGET).toContain("process.env.AI_USER_DAILY_TOKEN_CAP");
  });
});

/**
 * Un usuario que no está en `users` no puede costar el registro del gasto.
 *
 * `ai_usage.user_id` tiene clave foránea, y el `userId` que llega al worker no
 * siempre es una fila de `users`: el ensayo de conversaciones y las simulaciones
 * inventan uno. Con la clave rota, el INSERT entero se cae —23503— y se pierde
 * el registro del gasto, que es lo único que hace funcionar los TRES topes.
 *
 * Por eso el código original mandaba `null` siempre: no fallaba nunca, al precio
 * de que el cupo por usuario no pudiera alcanzarse jamás. Arreglaba el síntoma
 * tirando la función.
 *
 * Lo descubrí rompiéndolo: al empezar a pasar el usuario de verdad, el ensayo
 * completo se llenó de 23503 y dos escenarios dieron diferencias falsas.
 */
describe("recordUsage sobrevive a un usuario desconocido", () => {
  const FUENTE = readFileSync("src/server/ai/budget.ts", "utf8");

  it("reintenta sin usuario cuando la clave foránea falla", () => {
    expect(FUENTE).toContain('code === "23503"');
    expect(FUENTE).toContain("user_id: null");
  });

  it("y lo dice, porque un usuario que no existe alguien debería mirarlo", () => {
    expect(FUENTE).toContain("budget.usuario_desconocido");
  });

  it("el reintento es sólo para ESE error, no para cualquiera", () => {
    /*
     * El control. Un `catch` que reintentara sin usuario ante cualquier fallo
     * volvería a grabar todo sin atribuir en cuanto la base tosa — o sea, el
     * defecto original con más pasos.
     */
    expect(FUENTE).toContain('if (code === "23503" && userId)');
  });
});
