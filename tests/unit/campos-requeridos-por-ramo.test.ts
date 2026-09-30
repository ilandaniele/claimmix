/**
 * Qué datos pide cada ramo, más allá de los campos base (P6).
 *
 * `choque` y `rc` son los únicos que preguntan la hora: son los únicos ramos
 * donde importa un momento del día, no sólo un lugar.
 */

import { describe, it, expect } from "vitest";
import {
  CAMPOS_REQUERIDOS_POR_RAMO,
  camposRequeridosDelRamo,
  clavesQueSatisfacen,
} from "@/core/case/required-fields";
import { ClaimTypeSchema } from "@/lib/schemas/cases";

describe("CAMPOS_REQUERIDOS_POR_RAMO", () => {
  it("tiene una entrada para cada ClaimType", () => {
    for (const tipo of ClaimTypeSchema.options) {
      expect(CAMPOS_REQUERIDOS_POR_RAMO).toHaveProperty(tipo);
    }
  });

  it("sólo choque y rc piden hora_siniestro", () => {
    for (const tipo of ClaimTypeSchema.options) {
      const pideHora = CAMPOS_REQUERIDOS_POR_RAMO[tipo].includes("hora_siniestro");
      expect(pideHora).toBe(tipo === "choque" || tipo === "rc");
    }
  });

  it("accidente_personal y other sólo piden la provincia", () => {
    expect(CAMPOS_REQUERIDOS_POR_RAMO.accidente_personal).toEqual(["provincia_siniestro"]);
    expect(CAMPOS_REQUERIDOS_POR_RAMO.other).toEqual(["provincia_siniestro"]);
  });
});

describe("camposRequeridosDelRamo", () => {
  it("sin ramo, no pide nada extra", () => {
    expect(camposRequeridosDelRamo(null)).toEqual([]);
  });

  it("un ramo que no existe, tampoco", () => {
    expect(camposRequeridosDelRamo("x")).toEqual([]);
  });

  it("un ramo propio pide lo que su inquilino le configuró", () => {
    const ramos = [{ clave: "caucion", datos: ["testigos", "numero_denuncia"] }];
    expect(camposRequeridosDelRamo("caucion", ramos)).toEqual(["testigos", "numero_denuncia"]);
  });

  it("un dato que ya no está en el catálogo (tipo_vehiculo) no se pide: el modelo nunca lo trae", () => {
    const ramos = [{ clave: "caucion", datos: ["tipo_vehiculo", "testigos"] }];
    expect(camposRequeridosDelRamo("caucion", ramos)).toEqual(["testigos"]);
  });

  it("los datos del inquilino se suman a los de un ramo del código, no los reemplazan", () => {
    const ramos = [{ clave: "robo", datos: ["testigos"] }];
    expect(camposRequeridosDelRamo("robo", ramos)).toEqual(["patente_vehiculo", "provincia_siniestro", "testigos"]);
  });
});

describe("clavesQueSatisfacen", () => {
  it("la patente del asegurado no la satisface la de un tercero", () => {
    expect(clavesQueSatisfacen("patente_vehiculo")).not.toContain("party_b_plate");
  });
});
