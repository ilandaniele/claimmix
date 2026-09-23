/**
 * Lo que ya entendimos, dicho como lo diría una persona.
 *
 * El ensayo del 22/09 preguntó «¿fue el 2026-09-22?», «no hubo personas
 * lastimadas (null)» y «(false)». El valor de la base llegaba crudo al mensaje.
 */

import { describe, it, expect } from "vitest";
import { esValorVacio, valorLegible } from "@/core/mensajes/valor-legible";

const HOY = "2026-09-22";
const legible = (clave: string, valor: string | null | undefined, hoy = HOY) =>
  valorLegible(clave, valor, hoy);

describe("esValorVacio", () => {
  it("un vacío, un null o un undefined escritos como texto no son un valor", () => {
    for (const v of [undefined, null, "", "  ", "null", "NULL", " undefined "]) {
      expect(esValorVacio(v)).toBe(true);
    }
  });

  it("un no, un false o un cero sí lo son", () => {
    for (const v of ["no", "false", "0"]) expect(esValorVacio(v)).toBe(false);
  });
});

describe("valorLegible", () => {
  it("no hay nada que mostrar si el valor es vacío", () => {
    expect(legible("accident_location", "null")).toBeNull();
    expect(legible("hay_heridos", undefined)).toBeNull();
    expect(legible("full_name", "  ")).toBeNull();
  });

  it("dice la fecha como una persona", () => {
    expect(legible("accident_date", "2026-09-22")).toBe("22 de septiembre");
    expect(legible("accident_date", "2026-10-01")).toBe("1 de octubre");
    expect(legible("accident_date", "2024-03-15")).toBe("15 de marzo de 2024");
    expect(legible("accident_date", "2025-12-31", "2026-01-01")).toBe(
      "31 de diciembre de 2025"
    );
  });

  it("no corre el día por la hora ni por la zona", () => {
    expect(legible("accident_date", "2026-09-22T23:30:00-03:00")).toBe("22 de septiembre");
    expect(legible("accident_date", "2026-09-22T00:00:00Z")).toBe("22 de septiembre");
  });

  it("no inventa una fecha que no existe", () => {
    expect(legible("accident_date", "2026-02-31")).toBeNull();
    expect(legible("accident_date", "2026-13-01")).toBeNull();
  });

  it("una fecha que no es ISO sale tal cual", () => {
    for (const v of ["anteayer", "16/08/2026", "15/09"]) {
      expect(legible("accident_date", v)).toBe(v);
    }
  });

  it("el alias de la fecha se dice igual", () => {
    expect(legible("fecha_siniestro", "2026-09-22")).toBe(legible("accident_date", "2026-09-22"));
  });

  it("la fecha se decide por la clave, no por la forma del valor", () => {
    expect(legible("dni", "20220922")).toBe("20220922");
    expect(legible("policy_number", "POL-2026-0922")).toBe("POL-2026-0922");
    expect(legible("accident_location", "2026-09-22")).toBe("2026-09-22");
  });

  it("un booleano nunca sale como true o false", () => {
    for (const v of ["true", "TRUE", "si", "Sí", "yes"]) expect(legible("testigos", v)).toBe("sí");
    for (const v of ["false", "no"]) expect(legible("testigos", v)).toBe("no");
  });

  it("la gravedad de los heridos se dice como sí o no", () => {
    for (const clave of ["hay_heridos", "injury_severity", "heridos"]) {
      expect(legible(clave, "none")).toBe("no");
      for (const v of ["minor", "severe", "fatal"]) expect(legible(clave, v)).toBe("sí");
    }
    expect(legible("hay_heridos", "leve")).toBe("leve");
    expect(legible("hay_heridos", "el conductor del otro auto")).toBe(
      "el conductor del otro auto"
    );
  });

  it("la gravedad vale sólo para los heridos", () => {
    expect(legible("accident_location", "none")).toBe("none");
  });

  it("el tipo se traduce una vez", () => {
    expect(legible("claim_type", "choque")).toBe("choque de vehículo");
    expect(legible("tipo_siniestro", "granizo")).toBe("daño por granizo");
    expect(legible("claim_type", "other")).toBeNull();
    expect(legible("claim_type", "meteorito")).toBeNull();
    for (const v of ["constructor", "toString", "__proto__"]) {
      expect(legible("claim_type", v)).toBeNull();
    }
  });

  it("lo demás sale tal cual", () => {
    expect(legible("hora_siniestro", "tarde")).toBe("tarde");
    expect(legible("accident_location", " Villa Mitre ")).toBe("Villa Mitre");
    expect(legible("dni", "25.888.101")).toBe("25.888.101");
    expect(legible("testigos", "constructor")).toBe("constructor");
    expect(legible("hay_heridos", "toString")).toBe("toString");
  });

  it("es idempotente donde se puede, y en el tipo no", () => {
    const casos: [string, string][] = [
      ["accident_date", "2026-09-22"],
      ["accident_date", "2024-03-15"],
      ["hora_siniestro", "tarde"],
      ["hay_heridos", "false"],
      ["injury_severity", "minor"],
    ];
    for (const [clave, valor] of casos) {
      const una = legible(clave, valor)!;
      expect(legible(clave, una)).toBe(una);
    }
    expect(legible("claim_type", legible("claim_type", "choque"))).toBeNull();
  });
});
