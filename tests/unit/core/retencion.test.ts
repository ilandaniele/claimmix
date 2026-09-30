/**
 * Los dos interruptores de borrado nacen apagados y se apagan solos ante
 * cualquier valor que no se entienda: un typo nunca puede borrar ni achicar el
 * plazo de retención.
 */

import { describe, expect, it } from "vitest";

import { leerGracia, leerModo, leerRetencion, ventanaDiaria } from "@/core/retencion";

const AHORA = new Date("2026-09-30T04:10:00Z");

describe("leerModo", () => {
  it.each([
    ["simular", "simular"],
    ["borrar", "borrar"],
    [" Borrar ", "borrar"],
    ["SIMULAR", "simular"],
    ["apagado", "apagado"],
    ["", "apagado"],
    ["si", "apagado"],
    ["true", "apagado"],
    ["borrar!", "apagado"],
    [undefined, "apagado"],
    [null, "apagado"],
  ])("«%s» es %s", (valor, modo) => {
    expect(leerModo(valor)).toBe(modo);
  });
});

describe("leerRetencion", () => {
  it("sin variables: apagada, cinco años", () => {
    const r = leerRetencion({}, AHORA);
    expect(r).toMatchObject({ modo: "apagado", anios: 5 });
    expect(r.corte.toISOString()).toBe("2021-09-30T04:10:00.000Z");
  });

  it("modo borrar con los años por omisión", () => {
    expect(leerRetencion({ RETENCION_MODO: "borrar" }, AHORA)).toMatchObject({ modo: "borrar", anios: 5 });
  });

  it("respeta los años pedidos dentro de 1..30", () => {
    const r = leerRetencion({ RETENCION_MODO: "simular", RETENCION_ANIOS: "7" }, AHORA);
    expect(r).toMatchObject({ modo: "simular", anios: 7 });
    expect(r.corte.toISOString()).toBe("2019-09-30T04:10:00.000Z");
  });

  it.each(["0", "31", "-3", "5.5", "cinco", "5 años", "1e1", "99999"])(
    "RETENCION_ANIOS=%s apaga aunque el modo sea borrar",
    (anios) => {
      const r = leerRetencion({ RETENCION_MODO: "borrar", RETENCION_ANIOS: anios }, AHORA);
      expect(r.modo).toBe("apagado");
      expect(r.anios).toBe(5);
    }
  );

  it("un RETENCION_ANIOS vacío cuenta como no puesto", () => {
    expect(leerRetencion({ RETENCION_MODO: "borrar", RETENCION_ANIOS: "  " }, AHORA)).toMatchObject({
      modo: "borrar",
      anios: 5,
    });
  });

  it("no muta la fecha que recibe", () => {
    const antes = AHORA.toISOString();
    leerRetencion({}, AHORA);
    expect(AHORA.toISOString()).toBe(antes);
  });
});

describe("leerGracia", () => {
  it("30 días por omisión", () => {
    expect(leerGracia({})).toBe(30);
  });
  it.each([
    ["7", 7],
    ["90", 90],
    ["365", 365],
  ])("%s días", (valor, dias) => {
    expect(leerGracia({ PURGA_GRACIA_DIAS: valor })).toBe(dias);
  });
  it.each(["0", "6", "366", "-1", "7.5", "treinta", ""])("«%s» vuelve a 30", (valor) => {
    expect(leerGracia({ PURGA_GRACIA_DIAS: valor })).toBe(30);
  });
});

describe("ventanaDiaria", () => {
  it("sólo la hora 4 UTC", () => {
    expect(ventanaDiaria(new Date("2026-09-30T04:00:00Z"))).toBe(true);
    expect(ventanaDiaria(new Date("2026-09-30T04:59:59Z"))).toBe(true);
    expect(ventanaDiaria(new Date("2026-09-30T03:59:59Z"))).toBe(false);
    expect(ventanaDiaria(new Date("2026-09-30T05:00:00Z"))).toBe(false);
    expect(ventanaDiaria(new Date("2026-09-30T16:00:00Z"))).toBe(false);
  });
});
