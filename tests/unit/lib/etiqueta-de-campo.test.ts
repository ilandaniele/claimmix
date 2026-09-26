/**
 * `ExtractedFieldsTable`, `MissingDocsList` y `FieldConfirmationsPanel` cada
 * una traducía la clave y el valor a su manera. Esto prueba el lugar único.
 */

import { describe, it, expect } from "vitest";
import { getT } from "@/lib/i18n";
import { etiquetaDeCampo, tieneEtiqueta, valorParaMostrar } from "@/lib/labels/etiqueta-de-campo";

const t = getT("es-AR");
const HOY = "2026-09-22";

describe("etiquetaDeCampo", () => {
  it("un alias se etiqueta por su clave canónica", () => {
    expect(etiquetaDeCampo("numero_poliza", t)).toBe("Número de póliza");
  });

  it("un campo del schema tiene su propia etiqueta", () => {
    expect(etiquetaDeCampo("claim_type", t)).toBe("Tipo de siniestro");
  });

  it("un documento se etiqueta con `docs.*`", () => {
    expect(etiquetaDeCampo("fotos_danos", t)).toBe("Fotos de los daños");
  });

  it("una clave desconocida cae en el título de la clave cruda", () => {
    expect(etiquetaDeCampo("foo_bar", t)).toBe("Foo bar");
    expect(tieneEtiqueta("foo_bar")).toBe(false);
  });
});

describe("valorParaMostrar", () => {
  it("un booleano nunca sale como true o false", () => {
    expect(valorParaMostrar("hay_heridos", "none", t, HOY)).toBe("No");
    expect(valorParaMostrar("hay_heridos", "si", t, HOY)).toBe("Sí");
  });

  it("el tipo de siniestro sale traducido", () => {
    expect(valorParaMostrar("claim_type", "rc", t, HOY)).toBe("Resp. Civil");
  });

  it("una fecha ISO sale en su forma larga", () => {
    expect(valorParaMostrar("accident_date", "2026-09-22", t, HOY)).toBe("22 de septiembre");
  });
});
