/**
 * Un lote grande no puede depender de que todo entre en una invocación.
 *
 * Las extracciones simuladas se turnan a propósito —para no golpear al modelo
 * con cincuenta llamadas juntas— así que un lote se procesa en serie y cada caso
 * cuesta su extracción más el piso entre turnos. Los lotes medidos contra
 * producción tardaron entre 175 y 822 segundos para veinte casos: entre 8,75 y
 * 41 segundos por caso. Con el techo de 300 de la función, cincuenta casos no
 * entran ni en el mejor de esos números.
 *
 * Lo que pasaba entonces era silencioso: la invocación se cortaba, los casos
 * que faltaban quedaban en `procesando` y el reaper los escalaba al otro día. El
 * lote informaba "50 aceptadas" y el tablero terminaba con treinta y pico.
 *
 * La decisión de arrancar uno más se toma midiendo los anteriores, no con un
 * número escrito a mano, porque un caso tarda tres segundos o cuarenta según el
 * escenario y cómo venga el modelo ese día.
 */

import { describe, it, expect } from "vitest";
import {
  fitsAnotherCase,
  FIRST_CASE_ESTIMATE_MS,
  BATCH_BUDGET_MS,
  MAX_CHAIN,
} from "@/server/intake/batch-budget";

describe("fitsAnotherCase", () => {
  it("con la invocación recién arrancada, arranca el primero", () => {
    expect(fitsAnotherCase(0, 0)).toBe(true);
  });

  it("mide con lo que costaron los anteriores, no con una estimación", () => {
    // Diez casos en 100s son 10s cada uno: a los 100s todavía entra otro.
    expect(fitsAnotherCase(100_000, 10)).toBe(true);
    // Diez casos en 235s son 23,5s cada uno: no entra.
    expect(fitsAnotherCase(235_000, 10)).toBe(false);
  });

  it("no arranca uno que no va a terminar", () => {
    // Justo en el límite: 230s corridos, 20s por caso → 250 > 240.
    expect(fitsAnotherCase(230_000, 10, 240_000)).toBe(false);
    // Y con casos baratos, sí: 230s corridos, 5s por caso → 235 ≤ 240.
    expect(fitsAnotherCase(230_000, 46, 240_000)).toBe(true);
  });

  it("la primera estimación es pesimista a propósito", () => {
    // Sin ningún caso medido usa FIRST_CASE_ESTIMATE_MS. Si fuera optimista,
    // arrancaría un caso que no llega a terminar — y ese es justo el que se
    // pierde. Si resulta más barato, la medición lo corrige en la vuelta.
    expect(fitsAnotherCase(BATCH_BUDGET_MS - FIRST_CASE_ESTIMATE_MS + 1, 0)).toBe(false);
    expect(fitsAnotherCase(BATCH_BUDGET_MS - FIRST_CASE_ESTIMATE_MS, 0)).toBe(true);
  });

  it("el presupuesto deja aire para pasar el resto", () => {
    // maxDuration de la ruta es 300s. El presupuesto tiene que ser menor: al
    // cortar todavía hay que hacer el pedido HTTP que le pasa lo que queda a la
    // invocación siguiente, y si eso no entra, los casos quedan huérfanos.
    expect(BATCH_BUDGET_MS).toBeLessThan(300_000);
  });

  it("la cadena tiene tope, y alcanza para el lote más grande", () => {
    // Sin tope, una función que se llama a sí misma es un gasto sin fondo.
    // Con seis eslabones y el mínimo medido (8,75s por caso), entran más de
    // 150 casos: el máximo del endpoint es 50.
    expect(MAX_CHAIN).toBeGreaterThanOrEqual(3);
    const porEslabon = Math.floor(BATCH_BUDGET_MS / 8_750);
    expect(MAX_CHAIN * porEslabon).toBeGreaterThan(50);
  });
});
