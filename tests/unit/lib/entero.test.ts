import { afterEach, describe, expect, it, vi } from "vitest";
import { entero, enteroDe } from "@/lib/entero";

const VAR = "PRUEBA_ENTERO_QUE_NO_EXISTE";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("entero", () => {
  it("sin variable toma el valor por omisión", () => {
    expect(entero(VAR, 20, 0, 500)).toBe(20);
  });

  it("lee un entero, con espacios alrededor", () => {
    vi.stubEnv(VAR, " 7 ");
    expect(entero(VAR, 20, 0, 500)).toBe(7);
  });

  it("el piso y el techo valen", () => {
    vi.stubEnv(VAR, "0");
    expect(entero(VAR, 20, 0, 500)).toBe(0);
    vi.stubEnv(VAR, "500");
    expect(entero(VAR, 20, 0, 500)).toBe(500);
  });

  it("fuera de [min, max] toma la omisión, no el borde", () => {
    vi.stubEnv(VAR, "501");
    expect(entero(VAR, 20, 0, 500)).toBe(20);
    vi.stubEnv(VAR, "-1");
    expect(entero(VAR, 20, 0, 500)).toBe(20);
  });

  it("lo que no es un entero escrito con dígitos toma la omisión", () => {
    for (const crudo of ["", "  ", "abc", "NaN", "Infinity", "1.5", "1e3", "0x10", "12abc", "--1"]) {
      vi.stubEnv(VAR, crudo);
      expect(entero(VAR, 20, 0, 500), JSON.stringify(crudo)).toBe(20);
    }
  });

  it("un número que no cabe en un entero seguro toma la omisión", () => {
    vi.stubEnv(VAR, "99999999999999999999");
    expect(entero(VAR, 20, 0, Number.MAX_SAFE_INTEGER)).toBe(20);
  });
});

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
