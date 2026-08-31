/**
 * La regla que decide si le pedimos a alguien un dato que ya tenemos.
 *
 * El ensayo la descubrió del lado del asegurado: daba su DNI, el buscador
 * encontraba su póliza, y la respuesta siguiente le pedía el número de póliza.
 * Acá quedan afirmadas las tres decisiones —completar, no pisar, y preguntar
 * cuando hay ambigüedad— para que ninguna de las tres se pierda en silencio.
 */

import { describe, it, expect } from "vitest";

import { polizaParaCompletar, type PolizaCandidata } from "@/core/case/poliza-encontrada";

const AUTO: PolizaCandidata = {
  policyId: "p-1",
  policyNumber: "POL-8812-R",
  confidence: 0.95,
};
const CASA: PolizaCandidata = {
  policyId: "p-2",
  policyNumber: "POL-3300-H",
  confidence: 0.95,
};

describe("polizaParaCompletar", () => {
  it("completa cuando la persona no dio número y encontramos una sola", () => {
    expect(polizaParaCompletar(undefined, [AUTO])).toEqual(AUTO);
    expect(polizaParaCompletar(null, [AUTO])).toEqual(AUTO);
    expect(polizaParaCompletar("", [AUTO])).toEqual(AUTO);
    // Un campo que llegó con espacios sigue siendo un campo vacío.
    expect(polizaParaCompletar("   ", [AUTO])).toEqual(AUTO);
  });

  it("no pisa el número que dijo la persona", () => {
    expect(polizaParaCompletar("POL-5500-V", [AUTO])).toBeNull();
  });

  it("tampoco lo pisa cuando NO coincide con lo que encontramos", () => {
    /*
     * La mitad que importa: un número equivocado es una conversación con la
     * persona, no algo para corregirle por atrás. Si esto devolviera la póliza
     * encontrada, el caso diría una cosa y el asegurado recordaría otra.
     */
    expect(polizaParaCompletar("POL-0000-X", [AUTO])).toBeNull();
  });

  it("pregunta cuando la persona tiene dos pólizas", () => {
    // El auto o la casa: no sabemos bajo cuál viene el siniestro.
    expect(polizaParaCompletar(undefined, [AUTO, CASA])).toBeNull();
  });

  it("pregunta cuando no encontramos ninguna", () => {
    expect(polizaParaCompletar(undefined, [])).toBeNull();
  });

  it("una fila sin número no completa nada", () => {
    // Existe la fila y está el vínculo, pero no hay qué escribir. Sin esto se
    // marcaba el campo como sabido con la cadena vacía adentro.
    const sinNumero = { ...AUTO, policyNumber: "" };
    expect(polizaParaCompletar(undefined, [sinNumero])).toBeNull();
  });

  it("no toca lo que le pasan", () => {
    const encontradas = [AUTO];
    polizaParaCompletar(undefined, encontradas);
    expect(encontradas).toEqual([AUTO]);
  });
});
