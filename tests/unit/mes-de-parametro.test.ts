import { describe, it, expect } from "vitest";
import { mesDeParametro } from "@/core/billing/mes-de-parametro";

describe("mesDeParametro", () => {
  const ahora = new Date("2026-09-27T12:00:00Z");

  it("da el mes actual si el parámetro no tiene formato válido", () => {
    expect(mesDeParametro("garbage", ahora)).toBe("2026-09");
  });

  it("da el mes actual si el mes está fuera de rango", () => {
    expect(mesDeParametro("2026-13", ahora)).toBe("2026-09");
  });

  it("da el mes actual si el año queda fuera del rango facturable", () => {
    expect(mesDeParametro("1999-01", ahora)).toBe("2026-09");
  });

  it("conserva un mes válido", () => {
    expect(mesDeParametro("2026-09", ahora)).toBe("2026-09");
  });

  it("da el mes actual si no viene el parámetro", () => {
    expect(mesDeParametro(undefined, ahora)).toBe("2026-09");
  });
});
