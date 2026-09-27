/**
 * `escaparRegex` reemplaza cinco copias de la misma clase de escape, una de
 * ellas mal cerrada (severity-classifier.ts:44, antes de G1). El contrato es
 * simple: cualquier texto, con o sin metacaracteres, matchea literalmente
 * después de pasar por acá.
 */

import { describe, it, expect } from "vitest";
import { escaparRegex } from "@/core/text/escapar-regex";

const METACARACTERES = [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"];

const MUESTRAS = [
  "golpe (fuerte)",
  "a.b",
  "c++",
  "dano(s",
  "POL-8812-R",
  "[especial]",
  "$100.000",
  "sin metacaracteres",
];

describe("escaparRegex", () => {
  it.each(METACARACTERES)("escapa el metacarácter %j y matchea literal", (ch) => {
    const texto = `x${ch}y`;
    expect(() => new RegExp(escaparRegex(texto))).not.toThrow();
    expect(new RegExp(escaparRegex(texto)).test(texto)).toBe(true);
  });

  it.each(MUESTRAS)("'%s' compila y matchea literal", (muestra) => {
    expect(() => new RegExp(escaparRegex(muestra))).not.toThrow();
    expect(new RegExp(escaparRegex(muestra)).test(muestra)).toBe(true);
  });

  it("'a.b' escapado no matchea 'axb' — el punto queda literal", () => {
    expect(new RegExp(escaparRegex("a.b")).test("axb")).toBe(false);
  });
});
