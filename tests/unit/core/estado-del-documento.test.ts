/**
 * El estado de una fila de `missing_docs`, y qué ramos no tienen reglas
 * propias todavía.
 */

import { describe, it, expect } from "vitest";
import { estadoDelDocumento, esRamoSinCalibrar } from "@/core/case/required-docs";

describe("estadoDelDocumento", () => {
  it("con satisfied_at es received", () => {
    expect(estadoDelDocumento({ satisfied_at: "2026-08-20T00:00:00Z", declined_at: null })).toBe(
      "received"
    );
  });

  it("con declined_at es declined", () => {
    expect(estadoDelDocumento({ satisfied_at: null, declined_at: "2026-08-20T00:00:00Z" })).toBe(
      "declined"
    );
  });

  it("sin ninguna fecha es pending", () => {
    expect(estadoDelDocumento({ satisfied_at: null, declined_at: null })).toBe("pending");
  });

  it("requested_at no cuenta para nada", () => {
    expect(
      estadoDelDocumento({
        satisfied_at: null,
        declined_at: null,
        requested_at: "2026-08-20T00:00:00Z",
      } as never)
    ).toBe("pending");
  });
});

describe("esRamoSinCalibrar", () => {
  it("«other» no tiene reglas propias", () => {
    expect(esRamoSinCalibrar("other")).toBe(true);
  });

  it("«choque» sí las tiene", () => {
    expect(esRamoSinCalibrar("choque")).toBe(false);
  });
});
