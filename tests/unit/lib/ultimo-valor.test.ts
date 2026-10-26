import { describe, expect, it } from "vitest";

import { ultimoValor } from "@/lib/ultimo-valor";

describe("ultimoValor", () => {
  it("un parámetro suelto vale tal cual, también ausente", () => {
    expect(ultimoValor("1")).toBe("1");
    expect(ultimoValor("")).toBe("");
    expect(ultimoValor(undefined)).toBeUndefined();
  });

  it("repetido, vale el último", () => {
    expect(ultimoValor(["a", "b", "c"])).toBe("c");
    expect(ultimoValor(["a"])).toBe("a");
  });

  it("una lista vacía no tiene valor", () => {
    expect(ultimoValor([])).toBeUndefined();
  });
});
