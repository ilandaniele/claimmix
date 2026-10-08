/**
 * Los ramos con pocos casos reales: el detalle avisa que se revise con más cuidado.
 */

import { describe, it, expect } from "vitest";
import { RAMOS_EN_CALIBRACION, RAMOS_NATIVOS, esRamoEnCalibracion } from "@/core/case/ramos";

describe("esRamoEnCalibracion", () => {
  it.each(["cristales", "rc", "robo_contenido", "accidente_personal"])("«%s» está en calibración", (clave) => {
    expect(esRamoEnCalibracion(clave)).toBe(true);
  });

  it("choque no lo está", () => {
    expect(esRamoEnCalibracion("choque")).toBe(false);
  });

  it("sin ramo no lo está", () => {
    expect(esRamoEnCalibracion(null)).toBe(false);
  });

  it("un ramo propio del inquilino no lo está", () => {
    expect(esRamoEnCalibracion("mi_ramo")).toBe(false);
  });

  it("todos son ramos del código", () => {
    for (const clave of RAMOS_EN_CALIBRACION) expect(RAMOS_NATIVOS).toContain(clave);
  });
});
