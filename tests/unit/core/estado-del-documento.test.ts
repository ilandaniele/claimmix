/**
 * El estado de una fila de `missing_docs`, y qué ramos no tienen reglas
 * propias todavía.
 */

import { describe, it, expect } from "vitest";
import { estadoDelDocumento } from "@/core/case/estado-del-documento";
import { esRamoSinCalibrar } from "@/core/case/required-docs";

describe("estadoDelDocumento", () => {
  it("con satisfied_at es received", () => {
    expect(estadoDelDocumento({ satisfied_at: "2026-08-20T00:00:00Z", declined_at: null })).toBe(
      "received"
    );
  });

  it("con declined_at es declined", () => {
    expect(estadoDelDocumento({ satisfied_at: null, declined_at: "2026-08-20T00:00:00Z" })).toBe(
      "declined"
    );
  });

  it("sin ninguna fecha es pending", () => {
    expect(estadoDelDocumento({ satisfied_at: null, declined_at: null })).toBe("pending");
  });

  it("requested_at no cuenta para nada", () => {
    expect(
      estadoDelDocumento({
        satisfied_at: null,
        declined_at: null,
        requested_at: "2026-08-20T00:00:00Z",
      } as never)
    ).toBe("pending");
  });
});

describe("esRamoSinCalibrar", () => {
  it("«other» no tiene reglas propias", () => {
    expect(esRamoSinCalibrar("other")).toBe(true);
  });

  it("«choque» sí las tiene", () => {
    expect(esRamoSinCalibrar("choque")).toBe(false);
  });

  it("«other» con una fila de la aseguradora que pide documentos ya está calibrado", () => {
    expect(esRamoSinCalibrar("other", { documentos: ["fotos_danos"], datos: [] })).toBe(false);
  });

  it("«other» con una fila que sólo pide datos también", () => {
    expect(esRamoSinCalibrar("other", { documentos: [], datos: ["testigos"] })).toBe(false);
  });

  it("«other» con una fila vacía sigue sin calibrar", () => {
    expect(esRamoSinCalibrar("other", { documentos: [], datos: [] })).toBe(true);
  });

  it("un ramo propio sin fila (borrado) no está calibrado", () => {
    expect(esRamoSinCalibrar("mi_ramo", null)).toBe(true);
    expect(esRamoSinCalibrar("mi_ramo")).toBe(true);
  });

  it("un ramo propio con documentos o con datos sí", () => {
    expect(esRamoSinCalibrar("mi_ramo", { documentos: ["fotos_danos"], datos: [] })).toBe(false);
    expect(esRamoSinCalibrar("mi_ramo", { documentos: [], datos: ["testigos"] })).toBe(false);
    expect(esRamoSinCalibrar("mi_ramo", { documentos: [], datos: [] })).toBe(true);
  });

  it("un ramo del código con reglas propias no depende de la fila", () => {
    expect(esRamoSinCalibrar("choque", { documentos: [], datos: [] })).toBe(false);
  });
});
