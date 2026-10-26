/**
 * La mediana y el p95 del costo por caso, sin base.
 *
 * `costoPorCaso` recibe lo que devuelve `json_agg` (un número por caso real del
 * mes) y lo resume. Las cifras tienen que coincidir con `percentile_cont` de
 * Postgres, que interpola entre vecinos: con [1, 2, 3, 4] la mediana es 2,5 y
 * no 2 ni 3.
 */

import { describe, expect, it } from "vitest";
import { costoPorCaso } from "@/lib/billing/costo-por-caso";

describe("costoPorCaso", () => {
  it("sin ningún caso no hay cifra: undefined, no ceros", () => {
    expect(costoPorCaso([])).toBeUndefined();
    expect(costoPorCaso(null)).toBeUndefined();
    expect(costoPorCaso(undefined)).toBeUndefined();
    expect(costoPorCaso("[]")).toBeUndefined();
  });

  it("lo que no es un arreglo tampoco", () => {
    expect(costoPorCaso("{}")).toBeUndefined();
    expect(costoPorCaso("basura")).toBeUndefined();
    expect(costoPorCaso({ a: 1 })).toBeUndefined();
    expect(costoPorCaso(7)).toBeUndefined();
  });

  it("un solo caso: mediana y p95 son su costo", () => {
    expect(costoPorCaso([0.12])).toEqual({ cases: 1, median_usd: 0.12, p95_usd: 0.12 });
  });

  it("interpola entre vecinos, como percentile_cont", () => {
    expect(costoPorCaso([1, 2, 3, 4])).toEqual({ cases: 4, median_usd: 2.5, p95_usd: 3.85 });
    expect(costoPorCaso([0.1, 0.3])).toEqual({ cases: 2, median_usd: 0.2, p95_usd: 0.29 });
  });

  it("el orden de entrada no cambia la cifra y no muta el arreglo", () => {
    const entrada = [4, 1, 3, 2];

    expect(costoPorCaso(entrada)).toEqual(costoPorCaso([1, 2, 3, 4]));
    expect(entrada).toEqual([4, 1, 3, 2]);
  });

  it("acepta el arreglo como texto JSON, que es como puede llegar de la base", () => {
    expect(costoPorCaso("[0.1,0.3]")).toEqual(costoPorCaso([0.1, 0.3]));
  });

  it("redondea a 4 decimales", () => {
    expect(costoPorCaso([0.00001234])).toEqual({ cases: 1, median_usd: 0, p95_usd: 0 });
    expect(costoPorCaso([0.00426, 0.00426])?.median_usd).toBe(0.0043);
  });

  it("20 casos iguales: mediana y p95 coinciden", () => {
    const r = costoPorCaso(Array.from({ length: 20 }, () => 0.0042));

    expect(r).toEqual({ cases: 20, median_usd: 0.0042, p95_usd: 0.0042 });
  });

  it("descarta lo que no es un número finito y cuenta el resto", () => {
    expect(costoPorCaso([0.2, null, "x", Number.NaN, Number.POSITIVE_INFINITY, 0.4])).toEqual({
      cases: 2,
      median_usd: 0.3,
      p95_usd: 0.39,
    });
    expect(costoPorCaso([null, "x"])).toBeUndefined();
  });
});
