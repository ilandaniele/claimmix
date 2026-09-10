/**
 * La pantalla de métricas, ejecutada.
 *
 * `estados-que-cuentan-las-metricas.test.ts` prueba los CONJUNTOS
 * —`ESTADOS_COMPLETADO_SIN_PERSONA`, `ESTADOS_ESCALADO`— y hace bien: ese fue el
 * bug, y contarlos mal mostraba «0 %» y «0 siniestros» con 28 completados y 43
 * escalados en la base.
 *
 * Pero `getTenantKpis`, que es lo que convierte esas filas en los números que
 * mira una persona, tenía 0 % de cobertura. Las divisiones, los redondeos, el
 * `null` que distingue «no hubo cierres» de «cerró en cero minutos» y el relleno
 * de los nueve tipos de siniestro no los tocaba ningún test.
 *
 * Lo que se prueba acá es esa aritmética, sobre filas que la base podría
 * devolver de verdad.
 */

vi.mock("server-only", () => ({}));

const { mockVarias } = vi.hoisted(() => ({ mockVarias: vi.fn() }));

vi.mock("@/data/scope", () => ({
  enTenantVarias: mockVarias,
  enTenant: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTenantKpis } from "@/server/metrics/kpis";
import { ClaimTypeSchema } from "@/lib/schemas/cases";

const CTX = { tenantId: "10000000-0000-0000-0000-000000000001" };

const SIN_USO = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };

/**
 * Las nueve consultas del lote, en el orden en que `getTenantKpis` las arma.
 *
 * Lo que NO se prueba acá es el SQL: el armador no se ejecuta, así que una
 * consulta mal construida no se cae en este archivo. Eso lo cubren los tests
 * de integración, que corren contra una base de verdad. Acá está la aritmética
 * que hay entre las filas y la pantalla, que es lo que no tenía nada.
 */
function baseCon(over: Partial<{
  resumen: { total: number; listo: number; cerrados: number; minutos: number };
  porEstado: Array<{ status: string; n: number }>;
  porTipo: Array<{ claim_type: string | null; n: number }>;
  escalados: number;
  analistas: Array<{ assigned_to: string | null; full_name: string | null; n: number }>;
  usoDelMes: typeof SIN_USO;
  usoHistorico: typeof SIN_USO;
  porPersona: Array<Record<string, unknown>>;
  porModelo: Array<Record<string, unknown>>;
}> = {}) {
  mockVarias.mockImplementation(async () => [
    [over.resumen ?? { total: 0, listo: 0, cerrados: 0, minutos: 0 }],
    over.porEstado ?? [],
    over.porTipo ?? [],
    [{ n: over.escalados ?? 0 }],
    over.analistas ?? [],
    [over.usoDelMes ?? SIN_USO],
    [over.usoHistorico ?? SIN_USO],
    over.porPersona ?? [],
    over.porModelo ?? [],
  ]);
}

beforeEach(() => mockVarias.mockReset());

describe("getTenantKpis — la tasa de completitud", () => {
  it("es el porcentaje redondeado de los completados del mes", async () => {
    baseCon({ resumen: { total: 455, listo: 28, cerrados: 0, minutos: 0 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.total_cases_month).toBe(455);
    expect(summary.auto_completion_rate).toBe(6);
  });

  it("sin casos en el mes es 0 y no NaN", async () => {
    // `0 / 0` es NaN, y un NaN en esta pantalla se renderiza como «NaN%».
    baseCon({ resumen: { total: 0, listo: 0, cerrados: 0, minutos: 0 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.auto_completion_rate).toBe(0);
  });
});

describe("getTenantKpis — el tiempo de apertura", () => {
  it("promedia sólo los casos que de verdad se cerraron", async () => {
    baseCon({ resumen: { total: 10, listo: 2, cerrados: 4, minutos: 1000 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.avg_opening_time_minutes).toBe(250);
  });

  it("sin cierres es null, no cero", async () => {
    // Cero minutos es una afirmación —«se cierran al instante»— y no hubo
    // ningún cierre que la respalde. La pantalla muestra un guión con null.
    baseCon({ resumen: { total: 10, listo: 2, cerrados: 0, minutos: 0 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.avg_opening_time_minutes).toBeNull();
  });
});

describe("getTenantKpis — la distribución por tipo", () => {
  it("muestra los nueve tipos del esquema, incluso los que no tuvieron casos", async () => {
    // Sembrar sólo los que aparecen deja el gráfico leyéndose como si esos
    // tipos no existieran.
    baseCon({ porTipo: [{ claim_type: "choque", n: 12 }] });

    const { by_type } = await getTenantKpis(CTX);

    expect(by_type.choque).toBe(12);
    for (const t of ClaimTypeSchema.options) {
      expect(by_type).toHaveProperty(t);
    }
  });

  it("una fila sin tipo no inventa una categoría", async () => {
    baseCon({ porTipo: [{ claim_type: null, n: 7 }, { claim_type: "robo", n: 3 }] });

    const { by_type } = await getTenantKpis(CTX);

    expect(by_type.robo).toBe(3);
    expect(Object.values(by_type)).not.toContain(7);
  });
});

describe("getTenantKpis — el consumo de IA", () => {
  it("suma los tokens de las dos puntas y ordena por consumo", async () => {
    baseCon({
      porPersona: [
        { user_id: "u-1", full_name: "Ana", email: "ana@x.com", calls: 2, prompt_tokens: 100, completion_tokens: 50, cost_usd: 1 },
        { user_id: "u-2", full_name: "Beto", email: "beto@x.com", calls: 9, prompt_tokens: 900, completion_tokens: 100, cost_usd: 5 },
      ],
    });

    const { ai_usage } = await getTenantKpis(CTX);

    expect(ai_usage.by_user[0]!.full_name).toBe("Beto");
    expect(ai_usage.by_user[0]!.total_tokens).toBe(1000);
    expect(ai_usage.by_user[1]!.total_tokens).toBe(150);
  });

  it("lo que gastó el sistema tiene nombre, no una fila en blanco", async () => {
    // `user_id: null` es el worker: el gasto existe y alguien lo paga.
    baseCon({
      porPersona: [
        { user_id: null, full_name: null, email: null, calls: 3, prompt_tokens: 30, completion_tokens: 3, cost_usd: 0.1 },
      ],
    });

    const { ai_usage } = await getTenantKpis(CTX);

    expect(ai_usage.by_user[0]!.full_name).toBe("Sistema");
    expect(ai_usage.by_user[0]!.email).toBe("Procesos automáticos");
  });

  it("no muestra más de ocho personas", async () => {
    baseCon({
      porPersona: Array.from({ length: 12 }, (_, i) => ({
        user_id: `u-${i}`,
        full_name: `Persona ${i}`,
        email: `p${i}@x.com`,
        calls: 1,
        prompt_tokens: i * 10,
        completion_tokens: 0,
        cost_usd: 0,
      })),
    });

    const { ai_usage } = await getTenantKpis(CTX);

    expect(ai_usage.by_user).toHaveLength(8);
    // Las ocho que más gastaron, no las ocho primeras.
    expect(ai_usage.by_user[0]!.total_tokens).toBe(110);
  });

  it("las columnas numéricas vuelven como texto desde Drizzle y se convierten", async () => {
    baseCon({
      usoDelMes: { calls: "4", prompt_tokens: "1200", completion_tokens: "300", cost_usd: "0.0450" } as never,
    });

    const { ai_usage } = await getTenantKpis(CTX);

    expect(ai_usage.month.total_tokens).toBe(1500);
    expect(ai_usage.month.cost_usd).toBeCloseTo(0.045, 4);
  });
});

describe("getTenantKpis — los escalados", () => {
  it("salen de su propia consulta, no del conteo por estado", async () => {
    // El conteo por estado NO está acotado al mes; el de escalados sí. Leer uno
    // por el otro es cómo la tarjeta empieza a contar historia vieja.
    baseCon({
      escalados: 43,
      porEstado: [{ status: "requiere_especialista", n: 260 }],
    });

    const { summary, by_status } = await getTenantKpis(CTX);

    expect(summary.escalated_count).toBe(43);
    expect(by_status.requiere_especialista).toBe(260);
  });
});
