import { describe, it, expect } from "vitest";

import { exigirPlanPro } from "@/lib/auth/exigir-plan-pro";
import { AppError } from "@/lib/errors";

function ctx(plan: string) {
  return { userRow: { id: "u-1", tenant_id: "t-1", role: "admin" as const, plan } };
}

describe("exigirPlanPro", () => {
  it.each(["piloto", "operativo"])("con plan %s corta con 403 PLAN_REQUERIDO", (plan) => {
    let error: unknown;
    try {
      exigirPlanPro(ctx(plan));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("PLAN_REQUERIDO");
    expect((error as AppError).status).toBe(403);
  });

  it("con plan profesional deja pasar", () => {
    expect(() => exigirPlanPro(ctx("profesional"))).not.toThrow();
  });
});
