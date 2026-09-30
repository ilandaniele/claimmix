import { describe, expect, it } from "vitest";

import { nombresCompatibles, normalizarPatente } from "@/core/case/patente";

describe("normalizarPatente", () => {
  it.each(["AB 123 CD", "ab123cd", "AB-123-CD", " ab.123.cd "])("%s es AB123CD", (p) => {
    expect(normalizarPatente(p)).toBe("AB123CD");
  });
});

describe("nombresCompatibles", () => {
  it("comparten una palabra, sin tildes ni mayúsculas", () => {
    expect(nombresCompatibles("María José Pérez", "PEREZ MARIA")).toBe(true);
  });

  it("no alcanza con iniciales ni palabras cortas", () => {
    expect(nombresCompatibles("Al Li", "Al Li")).toBe(false);
    expect(nombresCompatibles("J. Pérez", "J. Gómez")).toBe(false);
  });

  it("dos personas distintas no son compatibles", () => {
    expect(nombresCompatibles("Juana Gómez", "Pedro Ramírez")).toBe(false);
  });
});
