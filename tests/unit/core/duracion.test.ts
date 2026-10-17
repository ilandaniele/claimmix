/**
 * Cuánto tardó algo, legible: segundos hasta el minuto, minutos hasta la hora, horas de ahí en adelante.
 * Sin dato (o un valor que no es una duración) es un guion, nunca «0 s».
 */

import { describe, expect, it } from "vitest";

import { duracionLegible } from "@/core/fecha/duracion";

describe("duracionLegible", () => {
  it("sin dato, o con un valor que no es una duración, es un guion", () => {
    for (const raro of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(duracionLegible(raro, "es-AR")).toBe("—");
    }
  });

  it("bajo el minuto son segundos enteros, y el cero es un cero", () => {
    expect(duracionLegible(0, "es-AR")).toBe("0 s");
    expect(duracionLegible(45, "es-AR")).toBe("45 s");
    expect(duracionLegible(59, "es-AR")).toBe("59 s");
  });

  it("bajo la hora son minutos, con la coma o el punto del idioma", () => {
    expect(duracionLegible(60, "es-AR")).toBe("1 min");
    expect(duracionLegible(150, "es-AR")).toBe("2,5 min");
    expect(duracionLegible(150, "en-US")).toBe("2.5 min");
    expect(duracionLegible(600, "es-AR")).toBe("10 min");
  });

  it("de la hora en adelante son horas", () => {
    expect(duracionLegible(3600, "es-AR")).toBe("1 h");
    expect(duracionLegible(3597, "es-AR")).toBe("1 h");
    expect(duracionLegible(59.6, "es-AR")).toBe("1 min");
    expect(duracionLegible(5400, "es-AR")).toBe("1,5 h");
    expect(duracionLegible(5400, "en-US")).toBe("1.5 h");
  });
});
