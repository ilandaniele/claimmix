/**
 * La celda de la forma «carga» se mide otra vez cuando pasa el presupuesto, y
 * falla sólo si se repite.
 *
 * El 11/09 el mismo commit dio 856, 557, 311 y 284 ms para «detalle de un caso»
 * con 20 analistas, con la columna de un analista quieta. Una regresión de
 * verdad se repite; un hipo del camino runner → Neon no. Lo que se fija acá:
 * cuándo se repite, cuándo no, y que el veredicto sale de la segunda medición
 * con las dos en el reporte. El presupuesto no se toca.
 */

import { describe, expect, it, vi } from "vitest";

import { medirCelda, type Sample } from "../../scripts/lib/medir-carga.mjs";

const PRESUPUESTO = 500;

/** Veinte muestras iguales: el p95 es exactamente ese valor. */
function muestras(ms: number, fallidas = 0): Sample[] {
  return Array.from({ length: 20 }, (_, i) => ({ ms, ok: i >= fallidas }));
}

function conMediciones(...tandas: Sample[][]) {
  const medir = vi.fn<(total: number, c: number, op: () => Promise<void>) => Promise<Sample[]>>();
  for (const t of tandas) medir.mockResolvedValueOnce(t);
  return medir;
}

const nada = async () => {};

describe("medirCelda", () => {
  it("dentro del presupuesto se mide una sola vez", async () => {
    const medir = conMediciones(muestras(300));
    const c = await medirCelda("detalle · 20", 20, 20, nada, PRESUPUESTO, medir);

    expect(medir).toHaveBeenCalledTimes(1);
    expect(c.ok).toBe(true);
    expect(c.repetida).toBeNull();
    expect(c.fila.p95).toBe(300);
  });

  it("pasada del presupuesto se repite, y si la segunda entra, la celda está bien", async () => {
    const medir = conMediciones(muestras(856), muestras(284));
    const c = await medirCelda("detalle · 20", 20, 20, nada, PRESUPUESTO, medir);

    expect(medir).toHaveBeenCalledTimes(2);
    expect(c.ok).toBe(true);
    // Las dos mediciones quedan: la primera no se esconde.
    expect(c.fila.p95).toBe(856);
    expect(c.repetida?.p95).toBe(284);
    expect(c.repetida?.etiqueta).toBe("detalle · 20 · repetida");
  });

  it("si se repite por encima, falla: eso ya no es un hipo", async () => {
    const medir = conMediciones(muestras(856), muestras(557));
    const c = await medirCelda("detalle · 20", 20, 20, nada, PRESUPUESTO, medir);

    expect(medir).toHaveBeenCalledTimes(2);
    expect(c.ok).toBe(false);
    expect(c.repetida?.p95).toBe(557);
  });

  it("una celda con consultas falladas no se repite: eso no es ruido", async () => {
    const medir = conMediciones(muestras(100, 3), muestras(100));
    const c = await medirCelda("detalle · 20", 20, 20, nada, PRESUPUESTO, medir);

    expect(medir).toHaveBeenCalledTimes(1);
    expect(c.ok).toBe(false);
    expect(c.fila.fallaron).toBe(3);
    expect(c.repetida).toBeNull();
  });

  it("la repetición tampoco perdona una consulta fallada", async () => {
    const medir = conMediciones(muestras(856), muestras(100, 1));
    const c = await medirCelda("detalle · 20", 20, 20, nada, PRESUPUESTO, medir);

    expect(c.ok).toBe(false);
    expect(c.repetida?.fallaron).toBe(1);
  });

  it("justo en el presupuesto no se repite: el umbral es «más que»", async () => {
    const medir = conMediciones(muestras(PRESUPUESTO));
    const c = await medirCelda("detalle · 20", 20, 20, nada, PRESUPUESTO, medir);

    expect(medir).toHaveBeenCalledTimes(1);
    expect(c.ok).toBe(true);
  });

  it("le pasa a `measure` exactamente lo que recibió, las dos veces", async () => {
    const medir = conMediciones(muestras(900), muestras(900));
    await medirCelda("x", 120, 5, nada, PRESUPUESTO, medir);

    expect(medir).toHaveBeenNthCalledWith(1, 120, 5, nada);
    expect(medir).toHaveBeenNthCalledWith(2, 120, 5, nada);
  });
});
