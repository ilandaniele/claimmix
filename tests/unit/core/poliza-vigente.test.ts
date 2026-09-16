/**
 * La regla de vigencia, sacada de `verificar_poliza`, y la derivación
 * automática cuando la póliza que dio la persona ya venció y no tiene otra
 * vigente.
 */

import { describe, it, expect } from "vitest";

import { polizaEnVigencia, mirarPolizas, type PolizaConNumero } from "@/core/case/poliza-vigente";

const HOY = "2026-09-16";

const VENCIDA: PolizaConNumero = {
  policyNumber: "POL-5500-V",
  status: "active",
  endDate: "2020-03-01",
};

describe("cuándo una póliza está en pie", () => {
  it("activa y sin fecha de fin está vigente", () => {
    expect(polizaEnVigencia({ status: "active", endDate: null }, HOY)).toBe(true);
  });

  it("activa con fecha pasada no está vigente", () => {
    expect(polizaEnVigencia({ status: "active", endDate: "2020-03-01" }, HOY)).toBe(false);
  });

  it("activa con fecha futura está vigente", () => {
    expect(polizaEnVigencia({ status: "active", endDate: "2099-01-01" }, HOY)).toBe(true);
  });

  it("el día del vencimiento todavía cubre", () => {
    expect(polizaEnVigencia({ status: "active", endDate: HOY }, HOY)).toBe(true);
  });

  it("expired no está vigente aunque la fecha no haya llegado", () => {
    expect(polizaEnVigencia({ status: "expired", endDate: "2099-01-01" }, HOY)).toBe(false);
  });

  it("cancelled tampoco", () => {
    expect(polizaEnVigencia({ status: "cancelled", endDate: null }, HOY)).toBe(false);
  });
});

describe("cuándo se deriva sin preguntarle al modelo", () => {
  it("una sola póliza, la que dio, vencida", () => {
    const resultado = mirarPolizas("POL-5500-V", [VENCIDA], HOY);
    expect(resultado.derivar).toBe(true);
    expect(resultado.vencioEl).toBe("2020-03-01");
    expect(resultado.noVigentes).toBe(1);
    expect(resultado.vigentes).toBe(0);
  });

  it("si tiene otra vigente, no se deriva", () => {
    const otraVigente: PolizaConNumero = {
      policyNumber: "POL-1",
      status: "active",
      endDate: "2099-01-01",
    };
    const resultado = mirarPolizas("POL-5500-V", [VENCIDA, otraVigente], HOY);
    expect(resultado.derivar).toBe(false);
    expect(resultado.vigentes).toBe(1);
  });

  it("sin número dicho no se deriva", () => {
    const resultado = mirarPolizas(undefined, [VENCIDA], HOY);
    expect(resultado.derivar).toBe(false);
    expect(resultado.noVigentes).toBe(1);
  });

  it("un número que no coincide con ninguna encontrada no deriva", () => {
    const resultado = mirarPolizas("POL-9999-X", [VENCIDA], HOY);
    expect(resultado.derivar).toBe(false);
  });

  it("cancelada sin fecha se deriva igual", () => {
    const cancelada: PolizaConNumero = {
      policyNumber: "POL-5500-V",
      status: "cancelled",
      endDate: null,
    };
    const resultado = mirarPolizas("POL-5500-V", [cancelada], HOY);
    expect(resultado.derivar).toBe(true);
    expect(resultado.vencioEl).toBeNull();
  });

  it("el número se compara normalizado", () => {
    // normalizarNumeroPoliza saca espacios y mayusculiza, pero no toca el
    // guion: con espacios alrededor del guion alcanza para probar que normaliza.
    const resultado = mirarPolizas("pol - 5500 - v", [VENCIDA], HOY);
    expect(resultado.derivar).toBe(true);
  });
});
