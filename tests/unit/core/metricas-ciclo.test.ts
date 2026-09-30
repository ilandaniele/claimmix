/**
 * Las piezas puras del ciclo, el historial mes a mes y los enlaces del tablero.
 *
 * El historial se pinta y se exporta a CSV: los dos tienen que tener SIEMPRE los
 * doce meses, aunque la base no devuelva uno, y un mes sin reclamos no puede
 * mostrar un 0 % ni un 0 h donde no hubo nada que medir.
 */

import { describe, it, expect } from "vitest";
import {
  COLUMNAS_DEL_HISTORIAL,
  completarHistorial,
  MESES_DEL_HISTORIAL,
  porcentaje,
  rangoDelHistorial,
  unDecimal,
  type FilaDeHistorial,
} from "@/core/metricas/ciclo";
import { hrefDeMetricas, vistaDe } from "@/core/metricas/enlaces";
import { getT } from "@/lib/i18n";

const SEPTIEMBRE = new Date("2026-09-15T15:00:00Z");

const fila = (mes: string, reclamos: number): FilaDeHistorial => ({
  mes,
  reclamos,
  con_listo: 1,
  mediana_horas_listo: 2,
  con_cierre: 1,
  mediana_horas_cierre: 30,
  sin_intervencion: 1,
  mensajes_por_caso: 4,
  completados: 1,
  escalados: 0,
  cerrados: 1,
});

describe("rangoDelHistorial", () => {
  it("son doce meses, el actual incluido, en horario argentino", () => {
    expect(rangoDelHistorial(SEPTIEMBRE)).toEqual({
      desde: "2025-10-01T03:00:00.000Z",
      hasta: "2026-10-01T03:00:00.000Z",
    });
  });

  it("en enero la ventana arranca en febrero del año anterior", () => {
    expect(rangoDelHistorial(new Date("2026-01-20T15:00:00Z")).desde).toBe("2025-02-01T03:00:00.000Z");
  });

  it("a las 23:30 del último día del mes sigue siendo ese mes, no el siguiente", () => {
    const ultimaNoche = new Date("2026-09-01T02:30:00Z");

    expect(rangoDelHistorial(ultimaNoche)).toEqual({
      desde: "2025-09-01T03:00:00.000Z",
      hasta: "2026-09-01T03:00:00.000Z",
    });
  });
});

describe("completarHistorial", () => {
  it("sin filas devuelve los doce meses en cero, del más viejo al actual", () => {
    const meses = completarHistorial(SEPTIEMBRE, []);

    expect(meses).toHaveLength(MESES_DEL_HISTORIAL);
    expect(meses[0]!.mes).toBe("2025-10");
    expect(meses.at(-1)!.mes).toBe("2026-09");
    expect(meses.every((m) => m.reclamos === 0 && m.completados === 0)).toBe(true);
  });

  it("un mes vacío no inventa medidas: sus medianas y sus mensajes son null", () => {
    const [vacio] = completarHistorial(SEPTIEMBRE, []);

    expect(vacio!.mediana_horas_listo).toBeNull();
    expect(vacio!.mediana_horas_cierre).toBeNull();
    expect(vacio!.mensajes_por_caso).toBeNull();
  });

  it("pone cada fila en su mes y deja el resto en cero", () => {
    const junio = fila("2026-06", 7);
    const meses = completarHistorial(SEPTIEMBRE, [junio]);

    expect(meses.find((m) => m.mes === "2026-06")).toEqual(junio);
    expect(meses.filter((m) => m.reclamos > 0)).toHaveLength(1);
  });

  it("cruza el año sin repetir ni saltear meses", () => {
    const meses = completarHistorial(new Date("2026-02-10T15:00:00Z"), []).map((m) => m.mes);

    expect(meses).toEqual([
      "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08",
      "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02",
    ]);
  });

  it("descarta lo que caiga fuera de la ventana", () => {
    const meses = completarHistorial(SEPTIEMBRE, [fila("2024-01", 9)]);

    expect(meses.some((m) => m.mes === "2024-01")).toBe(false);
    expect(meses.every((m) => m.reclamos === 0)).toBe(true);
  });
});

describe("porcentaje", () => {
  it("redondea al entero", () => {
    expect(porcentaje(1, 3)).toBe(33);
    expect(porcentaje(2, 3)).toBe(67);
    expect(porcentaje(3, 3)).toBe(100);
  });

  it("cero sobre algo es 0 %; cero sobre nada es null", () => {
    expect(porcentaje(0, 5)).toBe(0);
    expect(porcentaje(0, 0)).toBeNull();
    expect(porcentaje(3, 0)).toBeNull();
  });
});

describe("unDecimal", () => {
  it("redondea a un decimal", () => {
    expect(unDecimal(3.4567)).toBe(3.5);
    expect(unDecimal(7.25)).toBe(7.3);
    expect(unDecimal(12)).toBe(12);
  });

  it("null y undefined se quedan sin dato, y el cero es un dato", () => {
    expect(unDecimal(null)).toBeNull();
    expect(unDecimal(undefined)).toBeNull();
    expect(unDecimal(0)).toBe(0);
  });
});

describe("enlaces del tablero", () => {
  it("el período y la vista de siempre no se escriben en la URL", () => {
    expect(hrefDeMetricas({ serie: "mes", periodo: "este_mes" })).toBe("/metricas?serie=mes");
    expect(hrefDeMetricas({ serie: "mes", periodo: "este_mes", vista: "tablero" })).toBe("/metricas?serie=mes");
  });

  it("un período distinto y el historial sí, y no se pisan entre sí ni con la unidad", () => {
    expect(hrefDeMetricas({ serie: "dia", periodo: "mes_pasado" })).toBe("/metricas?serie=dia&periodo=mes_pasado");
    expect(hrefDeMetricas({ serie: "anio", periodo: "este_anio", vista: "historial" })).toBe(
      "/metricas?serie=anio&periodo=este_anio&vista=historial"
    );
  });

  it("vistaDe: sólo `historial` cambia la vista; todo lo demás es el tablero", () => {
    expect(vistaDe("historial")).toBe("historial");
    expect(vistaDe("tablero")).toBe("tablero");
    for (const otro of [undefined, "", "propias", ["historial"]]) expect(vistaDe(otro)).toBe("tablero");
  });
});

describe("COLUMNAS_DEL_HISTORIAL", () => {
  it("son nueve, sin repetir, y las dos lenguas las tienen escritas", () => {
    expect(COLUMNAS_DEL_HISTORIAL).toHaveLength(9);
    expect(new Set(COLUMNAS_DEL_HISTORIAL).size).toBe(9);
    for (const locale of ["es-AR", "en-US"] as const) {
      for (const c of COLUMNAS_DEL_HISTORIAL) expect(getT(locale)(c)).toBeTruthy();
    }
  });
});
