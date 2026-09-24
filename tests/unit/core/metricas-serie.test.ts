/**
 * La ventana de la serie de actividad de /metricas.
 *
 * El SQL agrupa en hora argentina; acá se prueba que la ventana que se lee y la
 * que se dibuja también lo sean. El caso que importa es la última noche del
 * mes: a las 23:30 de Buenos Aires ya es el día siguiente en UTC, y una ventana
 * en UTC terminaría en un período que todavía no empezó, vacío.
 */

import { describe, it, expect } from "vitest";
import {
  completarSerie,
  desdeDe,
  unidadDe,
  type PuntoSerie,
} from "@/core/metricas/serie";

// 2026-08-31 23:30 en Buenos Aires.
const ULTIMA_NOCHE_DE_AGOSTO = new Date("2026-09-01T02:30:00Z");

const fila = (clave: string, n: number): PuntoSerie => ({
  clave,
  reclamos: n,
  whatsapps: n,
  mails: n,
});

describe("serie de actividad — la frontera argentina", () => {
  it("el último día y el último mes son los de Buenos Aires, no los de UTC", () => {
    expect(completarSerie("dia", ULTIMA_NOCHE_DE_AGOSTO, []).at(-1)!.clave).toBe("2026-08-31");
    expect(completarSerie("mes", ULTIMA_NOCHE_DE_AGOSTO, []).at(-1)!.clave).toBe("2026-08");
    expect(completarSerie("anio", ULTIMA_NOCHE_DE_AGOSTO, []).at(-1)!.clave).toBe("2026");
  });

  it("se lee desde la medianoche argentina del primer período", () => {
    expect(desdeDe("dia", ULTIMA_NOCHE_DE_AGOSTO)).toBe("2026-08-02T03:00:00.000Z");
    expect(desdeDe("mes", ULTIMA_NOCHE_DE_AGOSTO)).toBe("2025-09-01T03:00:00.000Z");
    expect(desdeDe("anio", ULTIMA_NOCHE_DE_AGOSTO)).toBe("2022-01-01T03:00:00.000Z");
  });

  it("la primera clave dibujada es la del instante desde el que se lee", () => {
    for (const u of ["dia", "mes", "anio"] as const) {
      const primera = completarSerie(u, ULTIMA_NOCHE_DE_AGOSTO, [])[0]!.clave;
      expect(desdeDe(u, ULTIMA_NOCHE_DE_AGOSTO).startsWith(primera)).toBe(true);
    }
  });
});

describe("serie de actividad — los huecos", () => {
  it("mide 30, 12 y 5 períodos", () => {
    expect(completarSerie("dia", ULTIMA_NOCHE_DE_AGOSTO, [])).toHaveLength(30);
    expect(completarSerie("mes", ULTIMA_NOCHE_DE_AGOSTO, [])).toHaveLength(12);
    expect(completarSerie("anio", ULTIMA_NOCHE_DE_AGOSTO, [])).toHaveLength(5);
  });

  it("pone cada fila en su período y rellena el resto con cero", () => {
    const serie = completarSerie("mes", ULTIMA_NOCHE_DE_AGOSTO, [
      fila("2026-03", 4),
      fila("2025-10", 7),
    ]);

    expect(serie.find((p) => p.clave === "2026-03")).toEqual(fila("2026-03", 4));
    expect(serie.find((p) => p.clave === "2025-10")).toEqual(fila("2025-10", 7));
    expect(serie.filter((p) => p.reclamos === 0)).toHaveLength(10);
  });

  it("una fila fuera de la ventana no aparece", () => {
    const serie = completarSerie("mes", ULTIMA_NOCHE_DE_AGOSTO, [fila("2025-08", 9)]);

    expect(serie.map((p) => p.clave)).not.toContain("2025-08");
    expect(serie.every((p) => p.mails === 0)).toBe(true);
  });
});

describe("serie de actividad — los cambios de mes y de año", () => {
  it("la ventana diaria cruza el fin de mes sin saltear ni repetir días", () => {
    const claves = completarSerie("dia", new Date("2026-03-10T15:00:00Z"), []).map((p) => p.clave);

    expect(claves[0]).toBe("2026-02-09");
    expect(claves).toContain("2026-02-28");
    expect(claves).toContain("2026-03-01");
    expect(claves).not.toContain("2026-02-29");
    expect(new Set(claves).size).toBe(30);
    expect([...claves].sort()).toEqual(claves);
  });

  it("la ventana mensual cruza enero", () => {
    const claves = completarSerie("mes", new Date("2026-03-10T15:00:00Z"), []).map((p) => p.clave);

    expect(claves[0]).toBe("2025-04");
    expect(claves.slice(8, 10)).toEqual(["2025-12", "2026-01"]);
    expect(claves.at(-1)).toBe("2026-03");
  });

  it("la anual son los cinco años que terminan en el corriente", () => {
    const claves = completarSerie("anio", new Date("2026-03-10T15:00:00Z"), []).map((p) => p.clave);

    expect(claves).toEqual(["2022", "2023", "2024", "2025", "2026"]);
  });
});

describe("unidadDe", () => {
  it("acepta las tres unidades", () => {
    expect(unidadDe("dia")).toBe("dia");
    expect(unidadDe("mes")).toBe("mes");
    expect(unidadDe("anio")).toBe("anio");
  });

  it("cualquier otra cosa es mes, incluida una lista", () => {
    // `?serie=dia&serie=anio` llega como lista: no se elige una por la persona.
    expect(unidadDe(undefined)).toBe("mes");
    expect(unidadDe("x")).toBe("mes");
    expect(unidadDe(["dia"])).toBe("mes");
  });
});
