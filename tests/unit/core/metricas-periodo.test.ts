/**
 * El período del tablero: qué valores acepta y qué rango `[desde, hasta)` da en
 * horario argentino.
 *
 * Buenos Aires está tres horas atrás de UTC: el límite que importa es el de la
 * medianoche local, no el de UTC, y las fronteras de mes y de año son donde un
 * rango armado con `new Date(...)` en el huso del proceso se corre.
 */

import { describe, it, expect } from "vitest";
import {
  PERIODO_POR_DEFECTO,
  PERIODOS,
  PERIODOS_DEL_TABLERO,
  periodoDe,
  rangoDelPeriodo,
} from "@/core/metricas/periodo";

// Martes 15 de septiembre de 2026, mediodía en Buenos Aires.
const MARTES = new Date("2026-09-15T15:00:00Z");

describe("periodoDe", () => {
  it("acepta los cinco del tablero", () => {
    for (const p of PERIODOS_DEL_TABLERO) expect(periodoDe(p)).toBe(p);
  });

  it("lo que el tablero no ofrece cae al mes en curso, en vez de fallar", () => {
    for (const valor of ["hoy", "ayer", "anio_pasado", "", "cualquiera", null, undefined, 3, ["este_mes"]]) {
      expect(periodoDe(valor)).toBe(PERIODO_POR_DEFECTO);
    }
    expect(PERIODO_POR_DEFECTO).toBe("este_mes");
  });

  it("los del tablero son un subconjunto del vocabulario del asistente", () => {
    for (const p of PERIODOS_DEL_TABLERO) expect(PERIODOS).toContain(p);
  });
});

describe("rangoDelPeriodo", () => {
  it.each([
    ["hoy", "2026-09-15T03:00:00.000Z", "2026-09-16T03:00:00.000Z"],
    ["ayer", "2026-09-14T03:00:00.000Z", "2026-09-15T03:00:00.000Z"],
    ["esta_semana", "2026-09-14T03:00:00.000Z", "2026-09-16T03:00:00.000Z"],
    ["este_mes", "2026-09-01T03:00:00.000Z", "2026-10-01T03:00:00.000Z"],
    ["mes_pasado", "2026-08-01T03:00:00.000Z", "2026-09-01T03:00:00.000Z"],
    ["este_anio", "2026-01-01T03:00:00.000Z", "2027-01-01T03:00:00.000Z"],
    ["anio_pasado", "2025-01-01T03:00:00.000Z", "2026-01-01T03:00:00.000Z"],
    ["ultimos_30_dias", "2026-08-16T03:00:00.000Z", "2026-09-16T03:00:00.000Z"],
  ] as const)("%s", (periodo, desde, hasta) => {
    expect(rangoDelPeriodo(periodo, MARTES)).toEqual({ desde, hasta });
  });

  it("la semana empieza el lunes, también un domingo y el propio lunes", () => {
    const domingo = new Date("2026-09-20T15:00:00Z");
    const lunes = new Date("2026-09-14T15:00:00Z");

    expect(rangoDelPeriodo("esta_semana", domingo).desde).toBe("2026-09-14T03:00:00.000Z");
    expect(rangoDelPeriodo("esta_semana", lunes).desde).toBe("2026-09-14T03:00:00.000Z");
  });

  it("la semana cruza el fin de mes sin perder días", () => {
    // Miércoles 2 de septiembre: su lunes fue el 31 de agosto.
    const rango = rangoDelPeriodo("esta_semana", new Date("2026-09-02T15:00:00Z"));

    expect(rango.desde).toBe("2026-08-31T03:00:00.000Z");
  });

  it("en enero, el mes pasado es diciembre del año anterior", () => {
    const rango = rangoDelPeriodo("mes_pasado", new Date("2026-01-10T15:00:00Z"));

    expect(rango).toEqual({ desde: "2025-12-01T03:00:00.000Z", hasta: "2026-01-01T03:00:00.000Z" });
  });

  it("a las 23:30 de Buenos Aires del último día del mes todavía es ese mes", () => {
    // 02:30 UTC del 1 de septiembre es 23:30 del 31 de agosto en Buenos Aires.
    const ultimaNoche = new Date("2026-09-01T02:30:00Z");

    expect(rangoDelPeriodo("este_mes", ultimaNoche)).toEqual({
      desde: "2026-08-01T03:00:00.000Z",
      hasta: "2026-09-01T03:00:00.000Z",
    });
    expect(rangoDelPeriodo("hoy", ultimaNoche).desde).toBe("2026-08-31T03:00:00.000Z");
  });

  it("los ocho tienen rango, y siempre `desde` es anterior a `hasta`", () => {
    for (const p of PERIODOS) {
      const { desde, hasta } = rangoDelPeriodo(p, MARTES);
      expect(Date.parse(desde)).toBeLessThan(Date.parse(hasta));
    }
  });

  it("el instante de ahora cae adentro de los períodos que lo incluyen", () => {
    const ahora = MARTES.getTime();
    for (const p of ["hoy", "esta_semana", "este_mes", "este_anio", "ultimos_30_dias"] as const) {
      const { desde, hasta } = rangoDelPeriodo(p, MARTES);
      expect(Date.parse(desde)).toBeLessThanOrEqual(ahora);
      expect(Date.parse(hasta)).toBeGreaterThan(ahora);
    }
  });
});
