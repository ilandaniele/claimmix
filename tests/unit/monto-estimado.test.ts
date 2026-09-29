/**
 * El monto orientativo de un siniestro (B23): la tabla del tenant si la cargó,
 * la de por defecto si no, y el total de un presupuesto razonable encima.
 */

import { describe, expect, it } from "vitest";

import {
  ajustarConPresupuesto,
  estimarMonto,
  MONTOS_POR_DEFECTO,
  RangosDeMontoSchema,
  rangoPara,
} from "@/core/case/monto-estimado";
import { ClaimTypeSchema, SeveritySchema } from "@/lib/schemas/cases";

describe("rangoPara", () => {
  it("la tabla por defecto tiene todos los tipos menos «other», con mínimo ≤ máximo", () => {
    // «other» no tiene rango a propósito: no hay de dónde sacar uno.
    expect(MONTOS_POR_DEFECTO.other).toBeUndefined();
    for (const tipo of ClaimTypeSchema.options.filter((t) => t !== "other")) {
      for (const g of SeveritySchema.options) {
        const r = MONTOS_POR_DEFECTO[tipo]?.[g];
        expect(r, `${tipo}.${g}`).toBeDefined();
        expect(r!.minimo).toBeLessThanOrEqual(r!.maximo);
      }
    }
    expect(RangosDeMontoSchema.safeParse(MONTOS_POR_DEFECTO).success).toBe(true);
  });

  it("usa la celda del tenant y cae a la de por defecto donde no cargó", () => {
    const propios = { choque: { high: { minimo: 1, maximo: 2 } } };
    expect(rangoPara("choque", "high", propios)).toEqual({ minimo: 1, maximo: 2 });
    expect(rangoPara("choque", "low", propios)).toEqual(MONTOS_POR_DEFECTO.choque!.low);
    expect(rangoPara("robo", "high", null)).toEqual(MONTOS_POR_DEFECTO.robo!.high);
  });

  it("una tabla guardada que ya no valida no rompe: vale la de por defecto", () => {
    const rota = { choque: { high: { minimo: 5, maximo: 1 } } };
    expect(rangoPara("choque", "high", rota)).toEqual(MONTOS_POR_DEFECTO.choque!.high);
  });

  it("sin tipo o gravedad reconocidos, no hay rango", () => {
    expect(rangoPara(null, "high", null)).toBeNull();
    expect(rangoPara("choque", "enorme", null)).toBeNull();
    expect(estimarMonto("other", "low", null)).toBeNull();
  });
});

describe("estimarMonto y ajustarConPresupuesto", () => {
  const estimado = estimarMonto("choque", "medium", null)!;

  it("el estimado de la tabla dice de dónde sale", () => {
    expect(estimado).toEqual({ ...MONTOS_POR_DEFECTO.choque!.medium, moneda: "ARS", origen: "tabla" });
  });

  it("un total en pesos dentro del rango lo reemplaza", () => {
    expect(ajustarConPresupuesto(estimado, { total: 2_000_000, moneda: "ARS" })).toEqual({
      minimo: 2_000_000,
      maximo: 2_000_000,
      moneda: "ARS",
      origen: "presupuesto",
    });
  });

  it("fuera de rango, en otra moneda o sin total, queda la tabla", () => {
    expect(ajustarConPresupuesto(estimado, { total: 90_000_000, moneda: "ARS" })).toBe(estimado);
    expect(ajustarConPresupuesto(estimado, { total: 2_000_000, moneda: "USD" })).toBe(estimado);
    expect(ajustarConPresupuesto(estimado, { total: null, moneda: "ARS" })).toBe(estimado);
    expect(ajustarConPresupuesto(null, { total: 2_000_000, moneda: "ARS" })).toBeNull();
  });
});

describe("RangosDeMontoSchema", () => {
  it("rechaza mínimo mayor que máximo, negativos, tipos inventados y claves de más", () => {
    for (const malo of [
      { choque: { low: { minimo: 10, maximo: 1 } } },
      { choque: { low: { minimo: -1, maximo: 1 } } },
      { avion: { low: { minimo: 1, maximo: 2 } } },
      { choque: { low: { minimo: 1, maximo: 2, extra: 3 } } },
    ]) {
      expect(RangosDeMontoSchema.safeParse(malo).success).toBe(false);
    }
  });
});
