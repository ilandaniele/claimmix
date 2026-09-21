import { describe, it, expect } from "vitest";

import { ESTADOS_DE_ARRANQUE, puedeArrancar } from "@/core/case/estados-de-arranque";

describe("desde qué estados arranca el worker", () => {
  it("arranca desde los cuatro", () => {
    for (const status of ESTADOS_DE_ARRANQUE) expect(puedeArrancar(status)).toBe(true);
    expect(ESTADOS_DE_ARRANQUE).toHaveLength(4);
  });

  it("no desde escalado ni requiere_especialista", () => {
    expect(puedeArrancar("escalado")).toBe(false);
    expect(puedeArrancar("requiere_especialista")).toBe(false);
    expect(puedeArrancar("cerrado")).toBe(false);
  });
});
