import { describe, expect, it } from "vitest";
import { enteroDe } from "@/lib/entero";

describe("enteroDe", () => {
  it("lo que no es un entero escrito con dígitos da null", () => {
    for (const crudo of [undefined, "", "  ", "abc", "1.5", "1e3"]) {
      expect(enteroDe(crudo, 0, 500), JSON.stringify(crudo)).toBeNull();
    }
  });

  it("lee un entero, con espacios alrededor", () => {
    expect(enteroDe(" 7 ", 0, 500)).toBe(7);
  });

  it("el piso vale y lo que cae afuera da null", () => {
    expect(enteroDe("0", 0, 500)).toBe(0);
    expect(enteroDe("501", 0, 500)).toBeNull();
    expect(enteroDe("-1", 0, 500)).toBeNull();
  });

  it("un número que no cabe en un entero seguro da null", () => {
    expect(enteroDe("99999999999999999999", 0, Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});
