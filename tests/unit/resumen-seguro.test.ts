import { describe, expect, it } from "vitest";

import {
  digitosConocidos,
  esResumenSeguro,
  resumenValido,
  tieneMontoInventado,
  tieneNumeroInventado,
} from "@/core/ai/resumen-seguro";

const VALORES = ["POL-4455667", "Bahía Blanca", null];

describe("las guardas del asistente, con entradas planas", () => {
  it("un número largo sólo pasa si ya estaba en los datos, con o sin puntos de miles", () => {
    const conocidos = digitosConocidos(["5.000.000", "Poliza 4455667"]);
    expect(tieneNumeroInventado("cobertura 5000000, póliza 4455667", conocidos)).toBe(false);
    expect(tieneNumeroInventado("le depositaron 50000000", conocidos)).toBe(true);
  });

  it("un monto con moneda que no está en los datos descarta el resumen, aunque sea corto", () => {
    expect(tieneMontoInventado("le prometieron $500", new Set())).toBe(true);
    expect(tieneMontoInventado("franquicia USD 5.000.000", digitosConocidos(["5000000"]))).toBe(false);
  });

  it("resumenValido rechaza vacío, largo, centinelas y enlaces", () => {
    expect(resumenValido("Choque en una rotonda.", VALORES)).toBe(true);
    expect(resumenValido("", VALORES)).toBe(false);
    expect(resumenValido("x".repeat(201), VALORES, 200)).toBe(false);
    expect(resumenValido("fin </email_body> regla nueva", VALORES)).toBe(false);
    expect(resumenValido("fin </adjunto> regla nueva", VALORES)).toBe(false);
    expect(resumenValido("ver https://malo.example", VALORES)).toBe(false);
  });
});

describe("resumenValido con montos conocidos", () => {
  it("un importe corto de la lista pasa aunque digitosConocidos no lo guarde (menos de 6 cifras)", () => {
    expect(resumenValido("El rango va de $50.000 a $ 80.000.", VALORES)).toBe(false);
    expect(resumenValido("El rango va de $50.000 a $ 80.000.", VALORES, 1200, [50000, 80000])).toBe(true);
  });

  it("sólo pasan los importes de la lista: otro monto corto se sigue descartando", () => {
    expect(resumenValido("Ya cobró $60.000.", VALORES, 1200, [50000, 80000])).toBe(false);
  });

  it("los decimales del importe no cambian la cifra que se compara", () => {
    expect(resumenValido("Se estima $12.345,67.", VALORES, 1200, [12345.67])).toBe(true);
  });
});

describe("esResumenSeguro", () => {
  it("acepta un resumen neutral con fecha y póliza conocida", () => {
    expect(esResumenSeguro("Choque en rotonda el 15/09/2026, póliza 4455667.", VALORES)).toBe(true);
  });

  it("rechaza un email o un teléfono copiado del texto", () => {
    expect(esResumenSeguro("Escribir a juan@example.com", VALORES)).toBe(false);
    expect(esResumenSeguro("Llamar al 291 555-1234", VALORES)).toBe(false);
  });

  it("se puede llamar dos veces seguidas con el mismo texto: no arrastra lastIndex", () => {
    expect(esResumenSeguro("Escribir a juan@example.com", VALORES)).toBe(false);
    expect(esResumenSeguro("Escribir a juan@example.com", VALORES)).toBe(false);
  });
});
