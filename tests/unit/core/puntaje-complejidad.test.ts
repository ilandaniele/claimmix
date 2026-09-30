/**
 * El puntaje de complejidad (B13): un promedio ponderado que sólo ordena el
 * trabajo del equipo. Lo que tiene que cumplir siempre: entero de 0 a 100, sin
 * NaN aunque los pesos sean cero, y monótono.
 */

import { describe, expect, it } from "vitest";

import {
  PESOS_POR_DEFECTO,
  PesosSchema,
  RANGOS,
  bandaDe,
  camposDelPuntaje,
  clavesPonderadas,
  pesosDe,
  puntajeDeComplejidad,
  puntajeDelCaso,
  type Insumos,
  type Pesos,
} from "@/core/case/puntaje-complejidad";

const VACIOS: Insumos = { severidad: null, fraude: null, lesiones: null, monto: null, campos: {} };
const TOPE: Insumos = { severidad: "critical", fraude: "high", lesiones: "severe", monto: { maximo: 25_000_000 }, campos: {} };

describe("puntajeDeComplejidad", () => {
  it("con todos los insumos nulos da 0", () => {
    expect(puntajeDeComplejidad(VACIOS)).toBe(0);
  });

  it("crítica, fraude alto, lesión grave y monto sobre el umbral dan 100", () => {
    expect(puntajeDeComplejidad(TOPE)).toBe(100);
  });

  it("cada señal aporta su peso sobre el total", () => {
    expect(puntajeDeComplejidad({ ...VACIOS, severidad: "critical" })).toBe(35);
    expect(puntajeDeComplejidad({ ...VACIOS, fraude: "high" })).toBe(25);
    expect(puntajeDeComplejidad({ ...VACIOS, lesiones: "fatal" })).toBe(25);
    expect(puntajeDeComplejidad({ ...VACIOS, monto: { maximo: 50_000_000 } })).toBe(15);
  });

  it("el monto crece entre el umbral bajo y el alto, y usa el máximo del rango", () => {
    const pesos: Pesos = { ...PESOS_POR_DEFECTO, monto: { peso: 100, umbral: { bajo: 1000, alto: 3000 } } };
    const solo = (maximo: number | null) =>
      puntajeDeComplejidad({ ...VACIOS, monto: maximo === null ? null : { maximo } }, { ...pesos, severidad: 0, fraude: 0, lesiones: 0 });
    expect(solo(null)).toBe(0);
    expect(solo(1000)).toBe(0);
    expect(solo(2000)).toBe(50);
    expect(solo(3000)).toBe(100);
    expect(solo(9999)).toBe(100);
  });

  it("un valor desconocido no suma", () => {
    expect(puntajeDeComplejidad({ ...VACIOS, severidad: "rarísima", fraude: "none", lesiones: "none" })).toBe(0);
  });

  it("es monótono: subir cualquier insumo nunca baja el puntaje", () => {
    const escalas: [keyof Insumos, (string | { maximo: number } | null)[]][] = [
      ["severidad", [null, "low", "medium", "high", "critical"]],
      ["fraude", [null, "low", "medium", "high"]],
      ["lesiones", [null, "minor", "severe", "fatal"]],
      ["monto", [null, { maximo: 100_000 }, { maximo: 3_000_000 }, { maximo: 10_000_000 }, { maximo: 40_000_000 }]],
    ];
    const bases: Insumos[] = [VACIOS, TOPE, { ...VACIOS, severidad: "medium", fraude: "low" }];
    for (const base of bases) {
      for (const [campo, valores] of escalas) {
        let anterior = -1;
        for (const v of valores) {
          const p = puntajeDeComplejidad({ ...base, [campo]: v } as Insumos);
          expect(p).toBeGreaterThanOrEqual(anterior);
          anterior = p;
        }
      }
    }
  });

  it("con todos los pesos en 0 da 0, sin NaN", () => {
    const ceros: Pesos = { severidad: 0, fraude: 0, lesiones: 0, monto: { peso: 0, umbral: { bajo: 0, alto: 1 } }, campos: [] };
    expect(puntajeDeComplejidad(TOPE, ceros)).toBe(0);
  });

  it("siempre es un entero entre 0 y 100", () => {
    const escalas = { severidad: ["low", "medium", "high", "critical", null], fraude: ["low", "high", null], lesiones: ["minor", "fatal", null] };
    for (const severidad of escalas.severidad) {
      for (const fraude of escalas.fraude) {
        for (const lesiones of escalas.lesiones) {
          for (const monto of [null, { maximo: 1 }, { maximo: 7_000_000 }, { maximo: 1e10 }]) {
            const p = puntajeDeComplejidad({ severidad, fraude, lesiones, monto, campos: {} });
            expect(Number.isInteger(p)).toBe(true);
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(100);
          }
        }
      }
    }
  });

  it("un campo propio suma su peso cuando coincide, y su peso entra al total aunque no coincida", () => {
    const pesos: Pesos = { ...PESOS_POR_DEFECTO, campos: [{ clave: "vip", valor: "si", puntos: 100 }, { clave: "reincidente", puntos: 100 }] };
    const con = (campos: Insumos["campos"]) => puntajeDeComplejidad({ ...VACIOS, campos }, pesos);
    expect(con({})).toBe(0);
    expect(con({ vip: "SI" })).toBe(Math.round(100 * (100 / 300)));
    expect(con({ vip: "no" })).toBe(0);
    expect(con({ reincidente: "cualquier cosa", vip: "si" })).toBe(Math.round(100 * (200 / 300)));
    expect(con({ reincidente: "  " })).toBe(0);
  });
});

describe("PesosSchema", () => {
  it("acepta los de por defecto", () => {
    expect(PesosSchema.safeParse(PESOS_POR_DEFECTO).success).toBe(true);
  });

  it("rechaza pesos negativos, mayores que 100 y claves desconocidas", () => {
    expect(PesosSchema.safeParse({ ...PESOS_POR_DEFECTO, severidad: -1 }).success).toBe(false);
    expect(PesosSchema.safeParse({ ...PESOS_POR_DEFECTO, fraude: 101 }).success).toBe(false);
    expect(PesosSchema.safeParse({ ...PESOS_POR_DEFECTO, otro: 1 }).success).toBe(false);
    expect(PesosSchema.safeParse({ ...PESOS_POR_DEFECTO, campos: [{ clave: "x", puntos: 5, extra: true }] }).success).toBe(false);
  });

  it("rechaza un umbral al revés", () => {
    expect(PesosSchema.safeParse({ ...PESOS_POR_DEFECTO, monto: { peso: 15, umbral: { bajo: 10, alto: 10 } } }).success).toBe(false);
  });

  it("un JSON guardado que no valida vuelve a los pesos por defecto", () => {
    expect(pesosDe(null)).toBe(PESOS_POR_DEFECTO);
    expect(pesosDe({ severidad: 5 })).toBe(PESOS_POR_DEFECTO);
    const propios = { ...PESOS_POR_DEFECTO, severidad: 50 };
    expect(pesosDe(propios)).toEqual(propios);
  });
});

describe("bandaDe", () => {
  it("respeta los bordes 33/34 y 66/67", () => {
    expect(bandaDe(0)).toBe("baja");
    expect(bandaDe(33)).toBe("baja");
    expect(bandaDe(34)).toBe("media");
    expect(bandaDe(66)).toBe("media");
    expect(bandaDe(67)).toBe("alta");
    expect(bandaDe(100)).toBe("alta");
    expect(bandaDe(null)).toBeNull();
  });

  it("las bandas cubren 0 a 100 sin huecos", () => {
    expect(RANGOS.baja.hasta + 1).toBe(RANGOS.media.desde);
    expect(RANGOS.media.hasta + 1).toBe(RANGOS.alta.desde);
    expect(RANGOS.alta.hasta).toBe(100);
  });
});

describe("puntajeDelCaso", () => {
  const fila = { severity: "critical", fraud_risk_level: "high", injury_severity: "severe", monto_estimado: { maximo: 25_000_000 } };

  it("puntúa la fila del caso con los pesos por defecto cuando la aseguradora no cargó ninguno", () => {
    expect(puntajeDelCaso(fila, {}, null)).toBe(100);
    expect(puntajeDelCaso({ ...fila, severity: null, fraud_risk_level: null, injury_severity: "none", monto_estimado: null }, {}, null)).toBe(0);
  });

  it("cuenta los campos propios con el valor que tienen, y ignora los vacíos o ausentes", () => {
    const pesos = { ...PESOS_POR_DEFECTO, campos: [{ clave: "zona", valor: "riesgo", puntos: 100 }] };
    const sola = { severity: null, fraud_risk_level: null, injury_severity: null, monto_estimado: null };
    expect(puntajeDelCaso(sola, { zona: "Riesgo" }, pesos)).toBe(50);
    expect(puntajeDelCaso(sola, { zona: undefined }, pesos)).toBe(0);
    expect(puntajeDelCaso(sola, {}, pesos)).toBe(0);
  });

  it("unos pesos guardados que no validan vuelven a los de por defecto", () => {
    expect(puntajeDelCaso(fila, {}, { severidad: "mucho" })).toBe(100);
  });
});

describe("clavesPonderadas", () => {
  it("sin pesos propios no hay campos que leer", () => {
    expect(clavesPonderadas(null)).toEqual([]);
  });

  it("devuelve las claves de los campos ponderados sin repetir", () => {
    const pesos = {
      ...PESOS_POR_DEFECTO,
      campos: [
        { clave: "zona", valor: "a", puntos: 5 },
        { clave: "zona", valor: "b", puntos: 5 },
        { clave: "flota", puntos: 10 },
      ],
    };
    expect(clavesPonderadas(pesos)).toEqual(["zona", "flota"]);
  });
});

describe("camposDelPuntaje", () => {
  const pesos = {
    ...PESOS_POR_DEFECTO,
    campos: [
      { clave: "tiene_gnc", valor: "si", puntos: 5 },
      { clave: "flota", puntos: 10 },
    ],
  };

  it("toma de los campos guardados sólo los que los pesos cuentan; el que falta va en null", () => {
    const guardados = [
      { field_key: "tiene_gnc", field_value: "si" },
      { field_key: "full_name", field_value: "Juan Pérez" },
    ];
    expect(camposDelPuntaje(pesos, guardados)).toEqual({ tiene_gnc: "si", flota: null });
  });

  it("sin campos ponderados no lee ninguno", () => {
    expect(camposDelPuntaje(null, [{ field_key: "tiene_gnc", field_value: "si" }])).toEqual({});
  });
});
