import { describe, it, expect } from "vitest";
import { CaseQuerySchema } from "@/lib/schemas/cases";
import { buildCaseFilters } from "@/server/cases/list";

describe("sonda de extremo a extremo", () => {
  it("una URL con dos tipos llega a un IN con los dos", () => {
    const p = new URLSearchParams("type=choque&type=robo&severity=critical&page=2");
    const q = CaseQuerySchema.safeParse({
      type: p.getAll("type"),
      severity: p.getAll("severity"),
      status: p.getAll("status"),
      channel: p.getAll("channel"),
    });
    expect(q.success).toBe(true);
    if (!q.success) return;
    expect(q.data.type).toEqual(["choque", "robo"]);
    expect(q.data.severity).toEqual(["critical"]);
    expect(q.data.status).toBeUndefined();
    expect(buildCaseFilters(q.data)).toBeDefined();
  });

  it("un enlace viejo de un solo valor sigue andando", () => {
    const p = new URLSearchParams("type=choque");
    const q = CaseQuerySchema.safeParse({ type: p.getAll("type") });
    expect(q.success && q.data.type).toEqual(["choque"]);
  });

  it("un valor inventado entre validos rechaza el parametro entero", () => {
    expect(CaseQuerySchema.safeParse({ type: ["choque", "inventado"] }).success).toBe(false);
  });
});
