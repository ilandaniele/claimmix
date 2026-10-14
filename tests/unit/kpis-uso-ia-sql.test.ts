/**
 * El uso de IA del tablero de métricas, leído del acumulador mensual (0046).
 *
 * La lectura de IA del lote (posición 2) recorría `ai_usage` entera: crece con
 * la historia del inquilino y no la ayuda ningún índice. Ahora lee
 * `ai_usage_mensual`, una fila por (inquilino, mes, usuario, modelo), en UNA
 * consulta con tres agrupaciones: por persona, por modelo y los totales.
 * Acá se afirma, sin base, lo que se rompe en silencio: que ninguna vuelva a la
 * tabla grande, que el filtro del mes sea el mes argentino (un registro de las
 * 02:30 UTC del 1 de octubre todavía es de septiembre), que se sume `calls` y no
 * se cuenten filas del acumulador, y que el lote tenga las consultas que
 * tiene, en su orden.
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

/** Las cinco filas fijas del lote, más lo que cada test agregue al final. */
const filasDelLote = (extra: unknown[] = []) => [
  [],
  [],
  [{ grupo: 3, user_id: null, full_name: null, email: null, model: null, mes: SIN_USO, total: SIN_USO }],
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
  it("cinco consultas, y siete con la serie y ayer", async () => {
    expect(await lote()).toHaveLength(5);
    expect(await lote({ serie: "dia", ayer: true })).toHaveLength(7);
  });

  it("la posición 2 lee ai_usage_mensual y ninguna toca ai_usage", async () => {
    const consultas = await lote();

    expect(consultas[2].sql).toContain(`from "ai_usage_mensual"`);
    // El resto del lote no leyó nunca ai_usage: la tabla grande ya no está en el tablero.
    for (const q of consultas) expect(q.sql).not.toMatch(/\bai_usage\b/);
  });

  it("el ciclo y los cuellos siguen en las posiciones 3 y 4, con la valla de los cuellos", async () => {
    const consultas = await lote();

    expect(consultas[3].sql).toContain("percentile_cont(0.5)");
    expect(consultas[4].sql).toContain("lag(estado)");
    expect(consultas[4].sql).toMatch(/is not null\s+offset 0\s*\)\s*e\b/);
  });
});

describe("getTenantKpis — la lectura de IA", () => {
  it("el mes filtra cada suma y el total histórico ninguna, sin WHERE ni HAVING", async () => {
    const { sql, params } = (await lote())[2];

    // Sin WHERE: el filtro del mes va dentro de cada suma, y así el total
    // histórico sale de la misma pasada.
    const desdeElFrom = sql.slice(sql.indexOf('from "ai_usage_mensual"'));
    expect(desdeElFrom).not.toMatch(/\bwhere\b/);
    expect(desdeElFrom).not.toMatch(/\bhaving\b/);
    expect(sql).toContain(`coalesce(sum("ai_usage_mensual"."calls") filter (where "ai_usage_mensual"."mes" = $1), 0)::float8`);
    expect(sql).toContain(`coalesce(sum("ai_usage_mensual"."cost_usd"), 0)::float8`);
    expect(sql).not.toMatch(/count\(/);
    // Una vez por cada una de las cuatro sumas del mes, siempre el mismo.
    expect(params).toHaveLength(4);
    expect(new Set(params).size).toBe(1);
    expect(params[0]).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("por usuario: mismos joins y mismo agrupado que antes", async () => {
    const { sql } = (await lote())[2];

    expect(sql).toContain(`left join "users" on "users"."id" = "ai_usage_mensual"."user_id"`);
    expect(sql).toContain(`left join "user" on "user"."id" = "ai_usage_mensual"."user_id"`);
    expect(sql).toContain(`("ai_usage_mensual"."user_id", "users"."full_name", "user"."email")`);
  });

  it("por modelo y los totales: tres agrupaciones, y `grupo` dice de cuál es cada fila", async () => {
    const { sql } = (await lote())[2];

    expect(sql).toContain(
      `group by grouping sets (("ai_usage_mensual"."user_id", "users"."full_name", "user"."email"), ("ai_usage_mensual"."model"), ())`
    );
    expect(sql).toContain(`grouping("ai_usage_mensual"."user_id", "ai_usage_mensual"."model")::int`);
  });

  it("las cuatro sumas del mes usan el mismo parámetro", async () => {
    const { params } = (await lote())[2];

    expect(params).toEqual(Array(4).fill(params[0]));
  });
});

describe("getTenantKpis — el mes de IA es el mes argentino", () => {
  const mesDeLaLectura = async () => (await lote())[2].params[0];

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
