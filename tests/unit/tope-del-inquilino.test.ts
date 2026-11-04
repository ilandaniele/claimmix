/**
 * Lo que un inquilino ve del tope que saltó: el gasto del mensual es del proyecto entero,
 * sumado entre inquilinos, así que ni el 429 ni el historial lo llevan.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import type { TranslationKey } from "@/lib/i18n";
import type { BudgetCheckResult } from "@/server/ai/budget";
import { errorDelTope, motivoParaElHistorial, motivoSinGastoDelProyecto } from "@/server/ai/tope-del-inquilino";

const t = (clave: TranslationKey) => (esARServidor as Record<string, string>)[clave];

const MENSUAL: BudgetCheckResult = {
  exceeded: true,
  motivo: "mensual",
  reason: "Presupuesto mensual de IA agotado ($84.12 / $200).",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tope del inquilino", () => {
  it("con el tope del proyecto en 0 dice cómo se prende la IA y lo marca como frenada", () => {
    vi.stubEnv("MONTHLY_BUDGET_USD", "0");

    const error = errorDelTope(MENSUAL, t);

    expect(error.message).toBe(esARServidor["configuracion.capAyudaFrenada"]);
    expect(error.details).toEqual({ frenada: true });
    expect(motivoParaElHistorial(MENSUAL)).toBe("ia_pausada");
  });

  it("con el tope del proyecto mayor que 0 no muestra el gasto del proyecto", () => {
    vi.stubEnv("MONTHLY_BUDGET_USD", "200");

    const error = errorDelTope(MENSUAL, t);

    expect(error.code).toBe("AI_BUDGET_EXCEEDED");
    expect(error.message).toBe(esARServidor["asistente.presupuestoMensual"]);
    expect(error.message).not.toContain("84.12");
    expect(error.details).toBeUndefined();
    expect(motivoParaElHistorial(MENSUAL)).toBe("budget_exceeded");
  });

  it.each([
    ["prueba_mensual", "Presupuesto mensual de IA de la prueba agotado ($3.10 / $5)."],
    ["inquilino", "Presupuesto diario de tokens agotado para el tenant (100.000 / 100.000)."],
    ["persona", "Presupuesto diario de tokens agotado para el usuario (20.000 / 20.000)."],
  ] as const)("el motivo «%s» trae cifras propias y llega intacto", (motivo, reason) => {
    vi.stubEnv("MONTHLY_BUDGET_USD", "0");
    const tope: BudgetCheckResult = { exceeded: true, motivo, reason };

    expect(errorDelTope(tope, t).message).toBe(reason);
    expect(errorDelTope(tope, t).details).toBeUndefined();
    expect(motivoParaElHistorial(tope)).toBe(reason);
  });

  it("una fila vieja del mensual se muestra sin el gasto; las demás pasan como están", () => {
    expect(motivoSinGastoDelProyecto(MENSUAL.reason!)).toBe("budget_exceeded");
    expect(motivoSinGastoDelProyecto("Presupuesto mensual de IA de la prueba agotado ($3.10 / $5).")).toBe(
      "Presupuesto mensual de IA de la prueba agotado ($3.10 / $5)."
    );
    expect(motivoSinGastoDelProyecto("ia_pausada")).toBe("ia_pausada");
  });
});
