/**
 * El checklist de trabajo por tipo de siniestro (B11): busca el tipo, cae en el
 * comodín y después en el plan por defecto.
 */

import { describe, expect, it } from "vitest";

import { PLAN_POR_DEFECTO, PlanSchema, claveDeTituloDeFabrica, planPara, type Plan } from "@/core/case/plan-de-trabajo";
import { enUS } from "@/lib/i18n/en-US";
import { esAR } from "@/lib/i18n/es-AR";

const propio: Plan = {
  porTipo: {
    robo: [{ clave: "a", titulo: "A" }, { clave: "b", titulo: "B", auto: "pagado" }],
    "*": [{ clave: "z", titulo: "Z" }],
  },
};

describe("planPara", () => {
  it("usa el plan del tipo, en el orden en que está escrito", () => {
    expect(planPara("robo", propio).map((p) => p.clave)).toEqual(["a", "b"]);
    expect(planPara("robo", propio).map((p) => p.clave)).toEqual(["a", "b"]);
  });

  it("si el tipo no está, usa el comodín de la aseguradora", () => {
    expect(planPara("choque", propio).map((p) => p.clave)).toEqual(["z"]);
    expect(planPara(null, propio).map((p) => p.clave)).toEqual(["z"]);
  });

  it("sin plan propio, o sin tipo ni comodín, cae en el plan por defecto", () => {
    expect(planPara("choque", null)).toEqual(PLAN_POR_DEFECTO.porTipo.choque);
    expect(planPara("granizo", null)).toEqual(PLAN_POR_DEFECTO.porTipo["*"]);
    expect(planPara("choque", { porTipo: { robo: propio.porTipo.robo! } })).toEqual(PLAN_POR_DEFECTO.porTipo.choque);
    expect(planPara(null, { porTipo: { robo: propio.porTipo.robo! } })).toEqual(PLAN_POR_DEFECTO.porTipo["*"]);
  });

  it("el plan por defecto valida y tiene los pasos automáticos de la liquidación", () => {
    expect(PlanSchema.safeParse(PLAN_POR_DEFECTO).success).toBe(true);
    for (const pasos of Object.values(PLAN_POR_DEFECTO.porTipo)) {
      expect(pasos.some((p) => p.auto === "en_liquidacion")).toBe(true);
      expect(pasos.some((p) => p.auto === "pagado")).toBe(true);
    }
  });
});

describe("PlanSchema", () => {
  it("acepta un plan por tipo con comodín", () => {
    expect(PlanSchema.safeParse(propio).success).toBe(true);
  });

  it("rechaza claves duplicadas dentro de un mismo tipo, pero no entre tipos", () => {
    expect(PlanSchema.safeParse({ porTipo: { robo: [{ clave: "a", titulo: "A" }, { clave: "a", titulo: "Otra" }] } }).success).toBe(false);
    expect(PlanSchema.safeParse({ porTipo: { robo: [{ clave: "a", titulo: "A" }], choque: [{ clave: "a", titulo: "A" }] } }).success).toBe(true);
  });

  it("rechaza un auto distinto de en_liquidacion o pagado", () => {
    expect(PlanSchema.safeParse({ porTipo: { "*": [{ clave: "a", titulo: "A", auto: "cerrado" }] } }).success).toBe(false);
  });

  it("rechaza tipos desconocidos, listas vacías, claves mal escritas y campos de más", () => {
    expect(PlanSchema.safeParse({ porTipo: { volcan: [{ clave: "a", titulo: "A" }] } }).success).toBe(false);
    expect(PlanSchema.safeParse({ porTipo: { robo: [] } }).success).toBe(false);
    expect(PlanSchema.safeParse({ porTipo: { robo: [{ clave: "Con Espacio", titulo: "A" }] } }).success).toBe(false);
    expect(PlanSchema.safeParse({ porTipo: { robo: [{ clave: "a", titulo: "" }] } }).success).toBe(false);
    expect(PlanSchema.safeParse({ porTipo: {}, otra: 1 }).success).toBe(false);
  });
});

describe("claveDeTituloDeFabrica", () => {
  const pasosDeFabrica = Object.values(PLAN_POR_DEFECTO.porTipo).flat();

  it("cada paso de fábrica tiene su título en los dos idiomas, y en es-AR es el mismo texto que se copia al caso", () => {
    for (const p of pasosDeFabrica) {
      const clave = claveDeTituloDeFabrica(p);
      expect(clave, p.clave).toBe(`trabajo.paso.${p.clave}`);
      expect((esAR as Record<string, string>)[clave!], p.clave).toBe(p.titulo);
      expect((enUS as Record<string, string>)[clave!], p.clave).toBeTruthy();
      expect((enUS as Record<string, string>)[clave!], p.clave).not.toBe(p.titulo);
    }
  });

  it("un título que la aseguradora escribió o cambió no se traduce", () => {
    expect(claveDeTituloDeFabrica({ clave: "revisar_documentacion", titulo: "Mirar los papeles" })).toBeNull();
    expect(claveDeTituloDeFabrica({ clave: "paso_propio", titulo: "Revisar la documentación recibida" })).toBeNull();
  });
});
