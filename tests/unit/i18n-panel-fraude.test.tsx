/**
 * G30: el panel de fraude de `casos/[id]/page.tsx` pasa sus tres textos fijos
 * a i18n. En es-AR el texto tiene que quedar byte a byte igual al de hoy; en
 * en-US no puede aparecer el español.
 */

import { describe, it, expect } from "vitest";
import { esAR, enUS } from "@/lib/i18n/index";

describe("i18n del panel de fraude", () => {
  it("es-AR conserva el texto de hoy", () => {
    expect(esAR["case.detail.fraudAnalysis"]).toBe("Alertas de fraude");
    expect(esAR["case.detail.fraudDisclaimer"]).toBe(
      "Análisis automático — solo orientativo. La decisión final la toma el ajustador."
    );
    expect(esAR["case.detail.fraudNoDetails"]).toBe("Sin detalles adicionales.");
  });

  it("en-US no deja pasar el texto en español", () => {
    expect(enUS["case.detail.fraudAnalysis"]).not.toBe(esAR["case.detail.fraudAnalysis"]);
    expect(enUS["case.detail.fraudDisclaimer"]).not.toBe(esAR["case.detail.fraudDisclaimer"]);
    expect(enUS["case.detail.fraudNoDetails"]).not.toBe(esAR["case.detail.fraudNoDetails"]);
    for (const key of [
      "case.detail.fraudAnalysis",
      "case.detail.fraudDisclaimer",
      "case.detail.fraudNoDetails",
    ] as const) {
      expect(enUS[key], `en-US le falta '${key}'`).toBeTruthy();
    }
  });
});
