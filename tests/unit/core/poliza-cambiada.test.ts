/**
 * La póliza que cambia a mitad de la charla.
 *
 * El ensayo `devolver-al-agente` la descubrió: «POL-4471-A» en el primer mensaje
 * y «póliza 4455» en el segundo, y el agente se quedaba con el segundo sin
 * decir nada. Acá quedan afirmadas la comparación (4471 es POL-4471-A, 4455 no
 * es un celular) y la elección, que no se deja engañar por una negación.
 */

import { describe, it, expect } from "vitest";

import {
  nombraLaPoliza,
  polizaCambiada,
  polizaElegida,
  polizasNombradas,
} from "@/core/case/poliza-cambiada";
import { POLIZA_CAMBIADA } from "@/core/mensajes/poliza-cambiada";

describe("polizaCambiada", () => {
  it("es otra cuando los números no tienen nada que ver", () => {
    expect(polizaCambiada("POL-4471-A", "4455")).toBe(true);
    expect(polizaCambiada("POL-4471-A", "POL-4471-B")).toBe(true);
  });

  it("no es otra cuando es la misma dicha distinto", () => {
    expect(polizaCambiada("POL-4471-A", "pol 4471 a")).toBe(false);
    // Los dígitos solos son la misma póliza dicha a medias.
    expect(polizaCambiada("POL-4471-A", "4471")).toBe(false);
  });

  it("no es otra si falta alguno o no sirve como número", () => {
    expect(polizaCambiada(null, "4455")).toBe(false);
    expect(polizaCambiada("POL-4471-A", "12")).toBe(false);
    expect(polizaCambiada("N/A", "4455")).toBe(false);
  });
});

describe("nombraLaPoliza", () => {
  it("la encuentra entre otras cosas con dígitos", () => {
    expect(nombraLaPoliza("es un gol blanco patente AB123CD, póliza 4455", "4455")).toBe(true);
    expect(nombraLaPoliza("la POL 4471 A", "POL-4471-A")).toBe(true);
    expect(nombraLaPoliza("la 4455.", "4455")).toBe(true);
  });

  it("no la ve adentro de otro número", () => {
    expect(nombraLaPoliza("mi celu es 2914455123", "4455")).toBe(false);
  });

  it("no la ve si no está", () => {
    expect(nombraLaPoliza("gracias", "4455")).toBe(false);
  });
});

describe("polizasNombradas", () => {
  it("toma el número que el texto da como póliza", () => {
    expect(polizasNombradas("es un gol blanco patente AB123CD, póliza 4455")).toEqual(["4455"]);
    expect(polizasNombradas("Nro. de Póliza: POL-4471-A.")).toEqual(["POL-4471-A"]);
    expect(polizasNombradas("mi poliza es la 4455")).toEqual(["4455"]);
  });

  it("corta en la primera palabra que no es de relleno", () => {
    expect(polizasNombradas("la póliza no es 4455")).toEqual([]);
    expect(polizasNombradas("póliza y mi celular 2914455123")).toEqual([]);
  });

  it("no da nada sin la palabra póliza", () => {
    expect(polizasNombradas("la correcta es la POL-4471-A")).toEqual([]);
    expect(polizasNombradas(undefined)).toEqual([]);
  });
});

describe("polizaElegida", () => {
  const ANTERIOR = "POL-4471-A";
  const NUEVA = "4455";

  it("elige la que la lectura del extractor confirma y el texto nombra", () => {
    expect(polizaElegida("la correcta es la POL-4471-A", ANTERIOR, NUEVA, "POL-4471-A")).toBe(
      "anterior"
    );
    expect(polizaElegida("es la 4455", ANTERIOR, NUEVA, "4455")).toBe("nueva");
  });

  it("no elige la nueva cuando la nombra para negarla", () => {
    expect(polizaElegida("no es la 4455", ANTERIOR, NUEVA, "POL-4471-A")).toBeNull();
  });

  it("sin lectura, elige la única que el texto nombra", () => {
    expect(polizaElegida("la 4455", ANTERIOR, NUEVA, undefined)).toBe("nueva");
  });

  it("no elige si no nombra ninguna o nombra las dos", () => {
    expect(polizaElegida("no sé", ANTERIOR, NUEVA, undefined)).toBeNull();
    expect(polizaElegida("POL-4471-A o 4455, no sé", ANTERIOR, NUEVA, undefined)).toBeNull();
  });

  it("no elige si la lectura es un tercer número", () => {
    expect(polizaElegida("es la 7788", ANTERIOR, NUEVA, "7788")).toBeNull();
  });
});

describe("POLIZA_CAMBIADA", () => {
  it("no lleva ningún dígito", () => {
    expect(POLIZA_CAMBIADA).not.toMatch(/\d/);
  });

  it("dice de qué se trata", () => {
    expect(POLIZA_CAMBIADA).toContain("póliza");
    expect(POLIZA_CAMBIADA).toContain("coincid");
  });
});
