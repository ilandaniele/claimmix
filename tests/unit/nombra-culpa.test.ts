import { describe, expect, it } from "vitest";

import { NOMBRA_CULPA_O_LEY, nombraCulpaOLey } from "@/core/ai/nombra-culpa";

describe("nombraCulpaOLey", () => {
  it.each(["Es culpable el otro conductor", "la culpa es del tercero", "Ley 24.449", "ley 24449", "Ley 24.449.", "según el art. 48", "art. 123", "artículo 41", "articulo 44", "Art 44", "art4"])(
    "detecta %s",
    (texto) => {
      expect(nombraCulpaOLey(texto)).toBe(true);
    }
  );

  it.each([
    "Un siniestro de responsabilidad civil",
    "La póliza de RC cubre a terceros",
    "Recibimos tu denuncia y un analista la revisa",
    "El arte del taller",
    "Tu auto es un Fiat 500 del 2019",
    "Tu patente es ART 123",
    "la patente art123",
    "Mi DNI es 24.449.882",
    "DNI 12.24.449",
    "24449882",
  ])("no detecta %s", (texto) => {
    expect(nombraCulpaOLey(texto)).toBe(false);
  });

  it("no lleva un patrón por «responsab»: chocaría con la responsabilidad civil", () => {
    expect(NOMBRA_CULPA_O_LEY.some((re) => re.test("responsabilidad civil"))).toBe(false);
  });
});
