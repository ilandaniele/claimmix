/**
 * El catálogo de escenarios de simulación no se encoge sin que nadie mire.
 *
 * Varias suites generan un test por escenario, así que si el catálogo se
 * vaciara tendrían menos casos y seguirían en verde: el total baja y nadie mira
 * el total.
 *
 * Un piso, no un número exacto: agregar escenarios es lo que queremos que
 * pase, y romper el test por eso enseña a subirle el número sin pensar.
 */

import { describe, expect, it } from "vitest";
import { SCENARIOS } from "@/server/intake/scenarios";

describe("el catálogo de escenarios", () => {
  it("no se encogió sin que nadie mirara", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(160);
  });
});
