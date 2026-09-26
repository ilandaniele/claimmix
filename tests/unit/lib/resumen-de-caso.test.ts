/**
 * La frase de resumen del detalle del caso. Determinística: no usa el
 * `summary` del modelo.
 */

import { describe, it, expect } from "vitest";
import { getT } from "@/lib/i18n";
import { resumenDeCaso } from "@/lib/labels/resumen-de-caso";

const t = getT("es-AR");
const HOY = "2026-09-22";

describe("resumenDeCaso", () => {
  it("arma la frase completa", () => {
    expect(
      resumenDeCaso(
        {
          nombre: "Juan Pérez",
          tipo: "choque",
          fecha: "2026-09-20",
          lugar: "Ruta 2 km 45",
          lesiones: "minor",
          hoy: HOY,
        },
        t
      )
    ).toBe(
      "Juan Pérez reporta un siniestro de choque el 20 de septiembre en Ruta 2 km 45, con heridos."
    );
  });

  it("sin nombre usa «El asegurado»", () => {
    expect(
      resumenDeCaso(
        { nombre: null, tipo: "robo", fecha: null, lugar: null, lesiones: null, hoy: HOY },
        t
      )
    ).toBe("El asegurado reporta un siniestro de robo.");
  });

  it("«other» no lleva tipo", () => {
    expect(
      resumenDeCaso(
        { nombre: "Ana", tipo: "other", fecha: null, lugar: null, lesiones: null, hoy: HOY },
        t
      )
    ).toBe("Ana reporta un siniestro.");
  });

  it("sin tipo da null: el caso sigue en proceso", () => {
    expect(
      resumenDeCaso(
        { nombre: null, tipo: null, fecha: null, lugar: null, lesiones: null, hoy: HOY },
        t
      )
    ).toBeNull();
  });

  it("«none» da «, sin heridos»", () => {
    expect(
      resumenDeCaso(
        { nombre: null, tipo: "choque", fecha: null, lugar: null, lesiones: "none", hoy: HOY },
        t
      )
    ).toBe("El asegurado reporta un siniestro de choque, sin heridos.");
  });
});
