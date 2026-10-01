/**
 * El uso de IA del tablero de métricas, leído del acumulador mensual (0046).
 *
 * Las cuatro consultas de IA del lote (posiciones 5 a 8) recorrían `ai_usage`
 * entera: crecen con la historia del inquilino y no las ayuda ningún índice.
 * Ahora leen `ai_usage_mensual`, una fila por (inquilino, mes, usuario, modelo).
 * Acá se afirma, sin base, lo que se rompe en silencio: que ninguna vuelva a la
 * tabla grande, que el filtro del mes sea el mes argentino (un registro de las
 * 02:30 UTC del 1 de octubre todavía es de septiembre), que se sume `calls` y no
 * se cuenten filas del acumulador, y que el lote siga teniendo las mismas
 * consultas, en el mismo orden.
 */

vi.mock("server-only", () => ({}));

const { mockVarias } = vi.hoisted(() => ({ mockVarias: vi.fn() }));

vi.mock("@/data/scope", () => ({
  enTenantVarias: mockVarias,
  enTenant: vi.fn(),
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { getTenantKpis } from "@/server/metrics/kpis";

const CTX = { tenantId: "10000000-0000-0000-0000-000000000001" };
const SIN_USO = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };
const SIN_CICLO = {
  reclamos: 0,
  con_listo: 0,
  mediana_horas_listo: null,
  con_cierre: 0,
  mediana_horas_cierre: null,
  sin_intervencion: 0,
  mensajes_por_caso: null,
};

/** Las once filas fijas del lote, más lo que cada test agregue al final. */
const filasDelLote = (extra: unknown[] = []) => [
  [{ total: 0, listo: 0, respondidos: 0, minutos: 0 }],
  [],
  [],
  [{ n: 0 }],
  [],
  [SIN_USO],
  [SIN_USO],
  [],
  [],
  [SIN_CICLO],
  [],
  ...extra,
];

type Armada = { sql: string; params: unknown[] };

/** Arma el lote con un QueryBuilder de verdad y devuelve el SQL de cada consulta. */
async function lote(opts?: Parameters<typeof getTenantKpis>[1]): Promise<Armada[]> {
  mockVarias.mockResolvedValue(filasDelLote(opts?.serie && opts?.ayer ? [[], []] : opts?.serie || opts?.ayer ? [[]] : []));
  await getTenantKpis(CTX, opts);
  const armador = mockVarias.mock.calls.at(-1)![1] as (db: unknown) => Array<{ toSQL(): Armada }>;
  return armador(new QueryBuilder()).map((q) => q.toSQL());
}

beforeEach(() => mockVarias.mockReset());
afterEach(() => vi.useRealTimers());

describe("getTenantKpis — el lote con el acumulador de IA", () => {
  it("no cambia la cantidad de consultas: once, y trece con la serie y ayer", async () => {
    expect(await lote()).toHaveLength(11);
    expect(await lote({ serie: "dia", ayer: true })).toHaveLength(13);
  });

  it("las posiciones 5 a 8 leen ai_usage_mensual y ninguna toca ai_usage", async () => {
    const consultas = await lote();

    for (const i of [5, 6, 7, 8]) {
      expect(consultas[i].sql, `consulta ${i}`).toContain(`from "ai_usage_mensual"`);
      expect(consultas[i].sql, `consulta ${i}`).not.toMatch(/\bai_usage\b/);
    }
    // El resto del lote no leyó nunca ai_usage: la tabla grande ya no está en el tablero.
    for (const q of consultas) expect(q.sql).not.toMatch(/\bai_usage\b/);
  });

  it("el ciclo y los cuellos siguen en las posiciones 9 y 10, con la valla de los cuellos", async () => {
    const consultas = await lote();

    expect(consultas[9].sql).toContain("percentile_cont(0.5)");
    expect(consultas[10].sql).toContain("lag(estado)");
    expect(consultas[10].sql).toMatch(/is not null\s+offset 0\s*\)\s*e\b/);
  });
});

describe("getTenantKpis — las cuatro lecturas de IA", () => {
  it("el mes: filtra por el mes del acumulador y suma las llamadas", async () => {
    const { sql, params } = (await lote())[5];

    expect(sql).toMatch(/where "ai_usage_mensual"\."mes" = \$1$/);
    expect(params).toHaveLength(1);
    expect(params[0]).toMatch(/^\d{4}-\d{2}-01$/);
    expect(sql).toContain(`coalesce(sum("calls"), 0)::float8`);
    expect(sql).not.toMatch(/count\(/);
  });

  it("el total histórico: sin ningún filtro", async () => {
    const { sql, params } = (await lote())[6];

    expect(sql).not.toMatch(/\bwhere\b/);
    expect(params).toEqual([]);
    expect(sql).toContain(`coalesce(sum("cost_usd"), 0)::float8`);
  });

  it("por usuario: mismos joins y mismo agrupado que antes, sólo con el mes y los que usaron algo", async () => {
    const { sql, params } = (await lote())[7];

    expect(sql).toContain(`left join "users" on "users"."id" = "ai_usage_mensual"."user_id"`);
    expect(sql).toContain(`left join "user" on "user"."id" = "ai_usage_mensual"."user_id"`);
    expect(sql).toMatch(/where "ai_usage_mensual"\."mes" = \$1 /);
    expect(sql).toContain(`group by "ai_usage_mensual"."user_id", "users"."full_name", "user"."email"`);
    expect(sql).toMatch(/having sum\("ai_usage_mensual"\."calls"\) > 0$/);
    expect(sql).toContain(`coalesce(sum("ai_usage_mensual"."calls"), 0)::float8`);
    expect(params).toHaveLength(1);
  });

  it("por modelo: agrupa por modelo, con el mes y sólo los que tuvieron llamadas", async () => {
    const { sql, params } = (await lote())[8];

    expect(sql).toMatch(/where "ai_usage_mensual"\."mes" = \$1 group by "ai_usage_mensual"\."model"/);
    expect(sql).toMatch(/having sum\("ai_usage_mensual"\."calls"\) > 0$/);
    expect(params).toHaveLength(1);
  });

  it("las tres lecturas del mes usan el mismo parámetro", async () => {
    const consultas = await lote();

    expect(consultas[7].params).toEqual(consultas[5].params);
    expect(consultas[8].params).toEqual(consultas[5].params);
  });
});

describe("getTenantKpis — el mes de IA es el mes argentino", () => {
  const mesDeLaLectura = async () => (await lote())[5].params[0];

  it("a las 02:30 UTC del 1 de octubre todavía es septiembre en Buenos Aires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T02:30:00.000Z"));

    expect(await mesDeLaLectura()).toBe("2026-09-01");
  });

  it("a las 03:30 UTC ya es octubre", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T03:30:00.000Z"));

    expect(await mesDeLaLectura()).toBe("2026-10-01");
  });
});
