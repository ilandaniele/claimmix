/**
 * El nombre comercial de un plan, en el idioma de quien mira.
 *
 * Salía crudo de `plans.ts`, que guarda la etiqueta en castellano: la
 * facturación en inglés decía «Piloto plan». Traducirlo adentro de `plans.ts`
 * era la otra opción y por eso está acá — ese archivo es la aritmética de la
 * factura y se prueba entero sin levantar nada; meterle el diccionario para
 * escribir «Pilot» sería pagar ese precio por una etiqueta.
 *
 * La columna `tenants.plan` es `text` y no un enum, así que un plan fuera del
 * catálogo es posible y no tiene que dibujar un hueco.
 */

import { describe, it, expect } from "vitest";

import { nombreDePlan } from "@/lib/billing/plan-label";
import { PLANS } from "@/lib/billing/plans";
import { esAR } from "@/lib/i18n/es-AR";
import { enUS } from "@/lib/i18n/en-US";

const tEs = (k: keyof typeof esAR) => esAR[k];
const tEn = (k: keyof typeof enUS) => enUS[k];

describe("nombreDePlan", () => {
  it("traduce el plan al idioma de quien mira", () => {
    expect(nombreDePlan("piloto", "Piloto", tEs)).toBe("Piloto");
    expect(nombreDePlan("piloto", "Piloto", tEn)).toBe("Pilot");
  });

  it("todos los planes del catálogo tienen nombre en los dos idiomas", () => {
    for (const plan of PLANS) {
      expect(nombreDePlan(plan, "SIN TRADUCIR", tEs)).not.toBe("SIN TRADUCIR");
      expect(nombreDePlan(plan, "SIN TRADUCIR", tEn)).not.toBe("SIN TRADUCIR");
    }
  });

  it("un plan que no está en el catálogo cae en la etiqueta guardada", () => {
    expect(nombreDePlan("a-medida", "A medida", tEn)).toBe("A medida");
  });
});
