import { describe, expect, it } from "vitest";

import { sinControl, sinControlNiAngulares } from "@/core/text/sin-control";

describe("sinControl", () => {
  it.each(["Juan Pérez", "Av. Corrientes 1234, piso 5º", "Ñandú 🚗"])("deja pasar %s", (s) => {
    expect(sinControl(s)).toBe(true);
  });

  it.each([
    ["un salto de línea", "Juan\nPérez"],
    ["un NUL", "Juan\u0000"],
    ["una inversión bidireccional", "Juan‮Pérez"],
    ["un ancho cero", "Juan​Pérez"],
  ])("rechaza %s", (_, s) => {
    expect(sinControl(s)).toBe(false);
  });
});

describe("sinControlNiAngulares", () => {
  it("deja pasar un nombre común", () => {
    expect(sinControlNiAngulares("Caución")).toBe(true);
  });

  it.each(["<script>", "Juan>", "Juan\nPérez", "Juan‮Pérez"])("rechaza %j", (s) => {
    expect(sinControlNiAngulares(s)).toBe(false);
  });
});
