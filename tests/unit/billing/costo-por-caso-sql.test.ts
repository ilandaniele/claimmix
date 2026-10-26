/**
 * La consulta del costo por caso, afirmada por su forma (sin base).
 *
 * computeStatement lee el costo por caso dentro de la consulta del gasto, la
 * tercera de sus tres `enTenant`: un viaje más no se suma. Lo que se rompe en
 * silencio y acá se fija: que sigan siendo tres, en el orden inquilino →
 * conteos → gasto; que el gasto de cada caso se agrupe ANTES de unirlo a
 * `cases` (un caso cuenta una vez, no una por llamada); que `cases` vaya sin
 * alias, porque `esCasoReal` lo nombra; que sólo entren los casos reales creados
 * en el período; y que el uso se mire dentro del mismo período.
 *
 * Contra una base con casos no se prueba: el esquema real lo verifica el
 * ensayo y la 0054 aplicada a mano.
 */

vi.mock("server-only", () => ({}));

const { mockEnTenant } = vi.hoisted(() => ({ mockEnTenant: vi.fn() }));

vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { computeStatement } from "@/server/billing/statement";
import { resolveBillingPeriod } from "@/lib/billing/period";

const TENANT = "10000000-0000-0000-0000-000000000001";
const MARZO = resolveBillingPeriod("2026-03")!;

const tenantRow = {
  id: TENANT,
  name: "Aseguradora de prueba",
  plan: "operativo",
  billing_status: "active",
  monthly_fee_usd: "390.00",
  included_claims: 750,
  overage_price_usd: "0.4500",
  contact_email: "facturacion@example.com",
  trial_ends_at: null,
  activated_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

type Armada = { sql: string; params: unknown[] };
type Armador = (db: QueryBuilder) => { toSQL(): Armada };

/** Corre computeStatement y devuelve el SQL de cada una de sus llamadas a enTenant. */
async function armadas(gasto: unknown = {}): Promise<Armada[]> {
  mockEnTenant
    .mockResolvedValueOnce([tenantRow])
    .mockResolvedValueOnce([{ total: 0, billable: 0, rejected: 0, unresolved: 0 }])
    .mockResolvedValueOnce([gasto]);
  await computeStatement(TENANT, MARZO);
  return mockEnTenant.mock.calls.map((c) => (c[1] as Armador)(new QueryBuilder()).toSQL());
}

beforeEach(() => mockEnTenant.mockReset());

describe("computeStatement — el costo por caso dentro de la consulta del gasto", () => {
  it("sigue en tres enTenant: inquilino, conteos y gasto, en ese orden", async () => {
    const consultas = await armadas();

    expect(consultas).toHaveLength(3);
    expect(consultas[0].sql).toContain('from "tenants"');
    expect(consultas[1].sql).toContain('from "cases"');
    expect(consultas[1].sql).not.toContain("json_agg");
    expect(consultas[2].sql).toContain('from "ai_usage"');
    expect(consultas[2].sql).toContain("json_agg");
  });

  it("agrupa el gasto por caso antes de unir a cases, y deja afuera lo que no es de un caso", async () => {
    const { sql } = (await armadas())[2];

    expect(sql).toContain('"ai_usage"."case_id" is not null');
    const agrupa = sql.search(/group by\s+("ai_usage"\.)?"case_id"/);
    const une = sql.indexOf('join "cases" on "cases"."id" = u.case_id');
    expect(agrupa).toBeGreaterThan(-1);
    expect(une).toBeGreaterThan(agrupa);
  });

  it("cases va sin alias y con el filtro de inquilino, período y casos reales", async () => {
    const { sql } = (await armadas())[2];

    expect(sql).toContain('join "cases" on');
    expect(sql).toContain('"cases"."tenant_id"');
    expect(sql).toContain('"cases"."created_at"');
    // El mismo `esCasoReal` que cuenta las denuncias: simulados y ensayos no entran.
    expect(sql).toContain('"cases"."channel" in');
    expect(sql).toContain("not exists");
    expect(sql).toContain('from "claim_messages"');
  });

  it("el período entra como parámetro en el uso y en los casos, y vuelve '[]' si no hay ninguno", async () => {
    const { sql, params } = (await armadas())[2];

    expect(sql).toContain("coalesce((");
    expect(sql).toContain("'[]'::json");
    // Cada borde entra tres veces: la suma del mes, el gasto de cada caso y la creación del caso.
    expect(params.filter((p) => p === MARZO.start).length).toBeGreaterThanOrEqual(3);
    expect(params.filter((p) => p === MARZO.next).length).toBeGreaterThanOrEqual(3);
  });

  it("lo que devuelve el json llega a ai_cost.per_case, resumido", async () => {
    mockEnTenant
      .mockResolvedValueOnce([tenantRow])
      .mockResolvedValueOnce([{ total: 4, billable: 4, rejected: 0, unresolved: 0 }])
      .mockResolvedValueOnce([
        { calls: 9, prompt_tokens: 10, completion_tokens: 5, cost_usd: 1, costos_por_caso: [0.1, 0.3] },
      ]);

    const s = await computeStatement(TENANT, MARZO);

    expect(s?.ai_cost.per_case).toEqual({ cases: 2, median_usd: 0.2, p95_usd: 0.29 });
    expect(s?.ai_cost).not.toHaveProperty("costos_por_caso");
  });
});
