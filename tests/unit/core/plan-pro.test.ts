import { describe, it, expect } from "vitest";

import { esPlanPro } from "@/core/billing/plan-pro";

describe("esPlanPro", () => {
  it.each(["profesional", "corporativo", "enterprise"])("%s abre el Plan Pro", (plan) => {
    expect(esPlanPro(plan)).toBe(true);
  });

  it.each(["piloto", "operativo"])("%s no lo abre", (plan) => {
    expect(esPlanPro(plan)).toBe(false);
  });

  // Un dato roto o ausente cierra: nunca regala el Pro.
  it.each([null, undefined, "", "PROFESIONAL", "premium"])("%s cierra", (plan) => {
    expect(esPlanPro(plan)).toBe(false);
  });
});
