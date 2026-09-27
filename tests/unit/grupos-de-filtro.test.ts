/**
 * G35: el grupo de fraude en `GRUPOS_DE_FILTRO`.
 *
 * `filtrosPuestos` ya se prueba en general en `alternar-valores-de-filtro.test.ts`;
 * esto sólo cubre el grupo nuevo, con la misma forma de probar: sin URL,
 * pasando qué devuelve `leer` por parámetro.
 */

import { describe, expect, it } from "vitest";
import { filtrosPuestos } from "../../src/app/(app)/bandeja/components/grupos-de-filtro";

describe("filtrosPuestos — fraude", () => {
  it("fraude=high devuelve una marca", () => {
    const leer = (param: string) => (param === "fraude" ? ["high"] : []);

    const puestos = filtrosPuestos(leer);

    expect(puestos).toEqual([
      {
        param: "fraude",
        valor: "high",
        rotulo: "filter.fraude",
        etiqueta: "riesgo.fraude.high",
        color: "bg-red-600",
      },
    ]);
  });

  it("fraude=meteorito devuelve cero, porque no está en las opciones del grupo", () => {
    const leer = (param: string) => (param === "fraude" ? ["meteorito"] : []);

    expect(filtrosPuestos(leer)).toEqual([]);
  });
});
