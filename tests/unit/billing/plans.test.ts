/**
 * La prueba del alta automática: cuántos días dura, cuánta IA gasta y cuándo
 * una cuenta cuenta como prueba.
 *
 * `enPrueba` es lo que separa un espacio dado de alta solo de los inquilinos de
 * siempre, que también llevan 'piloto' y 'trial' porque son los valores por
 * omisión de la tabla. Si esa frontera se corre, el tope de la prueba le
 * cae a producción.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLANS,
  TOPE_DIARIO_TOKENS,
  diasDePrueba,
  enPrueba,
  llamadasDiariasDePrueba,
  pruebaVencida,
  topeDiarioDelPlan,
} from "@/lib/billing/plans";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("diasDePrueba", () => {
  it("sin variable dura 30 días", () => {
    vi.stubEnv("ALTA_PRUEBA_DIAS", "");
    expect(diasDePrueba()).toBe(30);
  });

  it("respeta un valor entre 1 y 90, bordes incluidos", () => {
    for (const dias of [1, 14, 90]) {
      vi.stubEnv("ALTA_PRUEBA_DIAS", String(dias));
      expect(diasDePrueba()).toBe(dias);
    }
  });

  it("0, negativo, 91, NaN o basura vuelven a 30: nunca una prueba sin fin", () => {
    for (const crudo of ["0", "-5", "91", "NaN", "abc", "7.5", "1e2", "Infinity"]) {
      vi.stubEnv("ALTA_PRUEBA_DIAS", crudo);
      expect(diasDePrueba(), crudo).toBe(30);
    }
  });
});

describe("topeDiarioDelPlan", () => {
  it("cada plan paga su escalón", () => {
    vi.stubEnv("AI_PILOTO_DAILY_TOKEN_CAP", "");
    expect(topeDiarioDelPlan("piloto")).toBe(500_000);
    expect(topeDiarioDelPlan("operativo")).toBe(5_000_000);
    expect(topeDiarioDelPlan("profesional")).toBe(20_000_000);
    expect(topeDiarioDelPlan("corporativo")).toBe(50_000_000);
    expect(topeDiarioDelPlan("enterprise")).toBe(50_000_000);
  });

  it("los topes suben con el plan", () => {
    const topes = PLANS.map((p) => TOPE_DIARIO_TOKENS[p]);
    expect(topes).toEqual([...topes].sort((a, b) => a - b));
  });

  it("el piloto lee AI_PILOTO_DAILY_TOKEN_CAP", () => {
    vi.stubEnv("AI_PILOTO_DAILY_TOKEN_CAP", "120000");
    expect(topeDiarioDelPlan("piloto")).toBe(120_000);
  });

  it("la variable del piloto no toca a los otros planes", () => {
    vi.stubEnv("AI_PILOTO_DAILY_TOKEN_CAP", "10");
    expect(topeDiarioDelPlan("profesional")).toBe(20_000_000);
  });

  it("una variable del piloto vacía, en cero, negativa o ilegible vuelve a 500.000", () => {
    for (const crudo of ["", "0", "-1", "20M", "NaN", "1.5"]) {
      vi.stubEnv("AI_PILOTO_DAILY_TOKEN_CAP", crudo);
      expect(topeDiarioDelPlan("piloto"), crudo).toBe(500_000);
    }
  });

  it("un plan fuera del catálogo cae al tope del piloto, no a uno más alto", () => {
    vi.stubEnv("AI_PILOTO_DAILY_TOKEN_CAP", "");
    expect(topeDiarioDelPlan("gratis")).toBe(500_000);
    expect(topeDiarioDelPlan("")).toBe(500_000);
  });
});

describe("llamadasDiariasDePrueba", () => {
  it("con el p95 de 12.730 tokens por llamada, 500.000 son 39 llamadas", () => {
    expect(llamadasDiariasDePrueba(500_000)).toBe(39);
  });

  it("redondea hacia abajo: 39 llamadas a p95 caben, 40 no", () => {
    expect(39 * 12_730).toBeLessThanOrEqual(500_000);
    expect(40 * 12_730).toBeGreaterThan(500_000);
    expect(llamadasDiariasDePrueba(12_729)).toBe(0);
    expect(llamadasDiariasDePrueba(12_730)).toBe(1);
  });

  it("un tope en cero, negativo o que no es número no deja llamar", () => {
    for (const tope of [0, -1, Number.NaN, -Infinity]) {
      expect(llamadasDiariasDePrueba(tope)).toBe(0);
    }
  });
});

describe("enPrueba", () => {
  it("un espacio de alta automática en trial está en prueba", () => {
    expect(enPrueba({ autoalta: true, billing_status: "trial" })).toBe(true);
  });

  it("un trial con autoalta en false no: es un inquilino de siempre", () => {
    expect(enPrueba({ autoalta: false, billing_status: "trial" })).toBe(false);
  });

  it("sin la columna (antes de la 0048) llega undefined y da false", () => {
    expect(enPrueba({ billing_status: "trial" })).toBe(false);
    expect(enPrueba({ autoalta: undefined, billing_status: "trial" })).toBe(false);
    expect(enPrueba({ autoalta: null, billing_status: "trial" })).toBe(false);
  });

  it("un espacio de alta automática que ya pagó deja de ser prueba", () => {
    for (const estado of ["active", "suspended", "churned", null, undefined]) {
      expect(enPrueba({ autoalta: true, billing_status: estado })).toBe(false);
    }
  });
});

describe("pruebaVencida", () => {
  const ahora = new Date("2026-10-07T12:00:00.000Z");

  it("vence en el instante exacto del fin: ≤ y no <", () => {
    expect(
      pruebaVencida({ billing_status: "trial", trial_ends_at: "2026-10-07T12:00:00.000Z" }, ahora)
    ).toBe(true);
  });

  it("un segundo antes del fin sigue vigente", () => {
    expect(
      pruebaVencida({ billing_status: "trial", trial_ends_at: "2026-10-07T12:00:01.000Z" }, ahora)
    ).toBe(false);
  });

  it("entiende la fecha como la devuelve Postgres, con o sin T y con +00", () => {
    expect(
      pruebaVencida({ billing_status: "trial", trial_ends_at: "2026-10-01 00:00:00+00" }, ahora)
    ).toBe(true);
    expect(
      pruebaVencida({ billing_status: "trial", trial_ends_at: "2026-11-01T00:00:00+00:00" }, ahora)
    ).toBe(false);
  });

  it("acepta un Date", () => {
    expect(
      pruebaVencida({ billing_status: "trial", trial_ends_at: new Date("2026-10-01") }, ahora)
    ).toBe(true);
  });

  it("sólo vence en trial: un plan activo con fecha vieja no se corta", () => {
    for (const estado of ["active", "suspended", "churned", null, undefined]) {
      expect(
        pruebaVencida({ billing_status: estado, trial_ends_at: "2020-01-01T00:00:00Z" }, ahora)
      ).toBe(false);
    }
  });

  it("un trial sin fecha no vence", () => {
    expect(pruebaVencida({ billing_status: "trial", trial_ends_at: null }, ahora)).toBe(false);
    expect(pruebaVencida({ billing_status: "trial" }, ahora)).toBe(false);
  });

  it("una fecha ilegible cuenta como vencida: falla cerrado", () => {
    expect(pruebaVencida({ billing_status: "trial", trial_ends_at: "mañana" }, ahora)).toBe(true);
  });
});
