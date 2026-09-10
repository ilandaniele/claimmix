/**
 * El corte que mataba lo que antes terminaba.
 *
 * `status='timeout'` en `provider_usage_events` aparece por primera vez el
 * 2026-09-09: la columna existía desde el día uno y nunca se había escrito,
 * porque no había nada que cortara por tiempo. O sea que los ochenta timeouts de
 * ese día no son «el modelo se puso lento» — son el corte estrenándose.
 *
 * Medido sobre 10.834 extracciones exitosas: p95 14.627 ms, p99 35.823 ms, y un
 * p95 por día que se mueve entre 8.444 y 47.169 ms. El 08/09, con el corte
 * todavía sin estrenar, 37 de 373 llamadas pasaron los 20 s y terminaron bien.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PLAZO_DEL_MODELO_MS } from "@/core/ai/plazo-del-modelo";

const EXTRACTOR = readFileSync("src/server/ai/gemini-extractor.ts", "utf8");
const WORKER = readFileSync("src/server/worker/extract.ts", "utf8");

describe("el plazo del modelo", () => {
  it("entra en el presupuesto de la corrida, una vez", () => {
    // 40 s es `PRESUPUESTO_DE_CORRIDA_MS`. Con reintento no entraría: dos
    // llamadas de 30 s son la función entera.
    expect(PLAZO_DEL_MODELO_MS).toBeLessThanOrEqual(40_000);
    expect(PLAZO_DEL_MODELO_MS * 2).toBeGreaterThan(40_000);
  });

  it("y deja pasar el p95 medido, con margen", () => {
    // p95 = 14.627 ms sobre 10.834 llamadas. Un corte por debajo de eso mata
    // una de cada veinte extracciones que iban a terminar bien.
    expect(PLAZO_DEL_MODELO_MS).toBeGreaterThan(14_627);
  });

  it("lo comparten el extractor y el worker, sin copiarlo", () => {
    // Dos números que tienen que coincidir y viven en dos archivos son dos
    // números que en algún momento dejan de coincidir.
    expect(EXTRACTOR).toContain("PLAZO_DEL_MODELO_MS");
    expect(WORKER).toContain("PLAZO_DEL_MODELO_MS");
    expect(EXTRACTOR).not.toMatch(/DEFAULT_GEMINI_TIMEOUT_MS\s*=\s*\d/);
  });
});

describe("un timeout no se reintenta", () => {
  /*
   * Caía en la rama de «tu respuesta anterior fue JSON inválido», que es un
   * consejo correcto para otro problema — el mismo defecto que ya se había
   * arreglado para MAX_TOKENS. Y el segundo intento manda el MISMO prompt de
   * ~10.600 tokens que acaba de no entrar, así que lo más probable es que
   * tampoco entre: otros treinta segundos de los cuarenta que hay.
   */
  it("el camino del timeout sale antes de armar la corrección", () => {
    const i = EXTRACTOR.indexOf('lastErrMeta?.code === "TIMEOUT"');
    const j = EXTRACTOR.indexOf("const correccion");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  it("y deja dicho que no reintentó, con el plazo que se agotó", () => {
    expect(EXTRACTOR).toContain("ai.email_extraction.timeout_sin_reintento");
  });
});

describe("la corrida no empieza una llamada que no le entra", () => {
  it("compara contra el plazo del modelo, no contra cero", () => {
    /*
     * Miraba `<= 0`, o sea «empezá si te queda un milisegundo». Arrancar la
     * llamada con cinco segundos de presupuesto garantiza que la maten en el
     * medio, que es justo lo que este control existe para evitar: un timeout
     * del modelo escala el caso, que lo maten a mitad de escritura no lo
     * escala nada.
     */
    expect(WORKER).toContain("restanteMs() < TIMEOUT_DEL_MODELO_MS");
    expect(WORKER).not.toContain("restanteMs() <= 0");
  });
});
