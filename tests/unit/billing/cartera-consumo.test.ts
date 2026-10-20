/**
 * Lo que la cartera suma para mirar el consumo de cada cliente: si nació por el alta
 * automática, el estado y el peso de su base propia, y cuánto cuesta cada denuncia.
 *
 * Todo sale de la misma consulta de `tenants` que ya existía, así que acá se prueba cómo
 * se mapea la fila y que el SQL de las columnas nuevas mira lo que debe.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  /** Lo que contesta `db.select`, en orden: clientes, casos, gasto y facturas. */
  cola: [] as unknown[][],
  /** Los campos que recibió cada `select`, en el mismo orden. */
  campos: [] as Array<Record<string, unknown>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/ai/budget", () => ({ getDemoTenantId: () => null }));

vi.mock("@/lib/db", async () => {
  const { tenants, cases, aiUsage, billingInvoices } = await import("@/lib/db/schema");
  return {
    db: {
      select: (campos: Record<string, unknown>) => {
        h.campos.push(campos);
        const q: Record<string, unknown> = {};
        for (const m of ["from", "where", "groupBy", "orderBy"]) q[m] = () => q;
        q.then = (resolver: (v: unknown) => unknown, rechazo: (e: unknown) => unknown) =>
          Promise.resolve(h.cola.shift() ?? []).then(resolver, rechazo);
        return q;
      },
    },
    tables: { tenants, cases, aiUsage, billingInvoices },
  };
});

import { listTenantSummaries } from "@/server/billing/tenant-summary";

const UNO = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MES = "2026-07";

/** Una fila de `tenants` como la devolvía la consulta antes de las columnas nuevas. */
const viejo = (extra: Record<string, unknown> = {}) => ({
  id: UNO,
  name: "Seguros del Sur",
  plan: "piloto",
  billing_status: "trial",
  monthly_fee_usd: "100",
  included_claims: 10,
  overage_price_usd: "2",
  contact_email: null,
  trial_ends_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  ...extra,
});

async function cartera(fila: Record<string, unknown>, opts: { billable?: number; gasto?: number } = {}) {
  h.cola.length = 0;
  h.campos.length = 0;
  h.cola.push(
    [fila],
    opts.billable === undefined ? [] : [{ tenant_id: UNO, total: opts.billable, billable: opts.billable }],
    opts.gasto === undefined ? [] : [{ tenant_id: UNO, cost_usd: opts.gasto }],
    [],
  );
  const { tenants } = await listTenantSummaries(MES);
  return tenants[0];
}

beforeEach(() => {
  delete process.env.BASE_POR_CLIENTE;
});

describe("la cartera con el consumo de cada cliente", () => {
  it("mapea la fila con autoalta, base lista y su peso", async () => {
    const t = await cartera(viejo({ autoalta: true, base_estado: "lista", base_mb: 12 }));

    expect(t).toMatchObject({ autoalta: true, base_estado: "lista", base_mb: 12 });
  });

  it("un estado de base que no es de la lista da null", async () => {
    const t = await cartera(viejo({ base_estado: "rara" }));

    expect(t.base_estado).toBeNull();
  });

  it("sin peso medido no inventa uno", async () => {
    expect((await cartera(viejo({ base_mb: null }))).base_mb).toBeNull();
    expect((await cartera(viejo({ base_mb: -1 }))).base_mb).toBeNull();
    expect((await cartera(viejo({ base_mb: "x" }))).base_mb).toBeNull();
  });

  it("el costo medio es la IA del mes sobre las denuncias facturables", async () => {
    const t = await cartera(viejo(), { billable: 4, gasto: 3 });

    expect(t).toMatchObject({ billable_claims: 4, ai_cost_usd: 3, costo_medio_usd: 0.75 });
  });

  it("sin denuncias facturables no hay costo medio", async () => {
    const t = await cartera(viejo(), { billable: 0, gasto: 3 });

    expect(t.costo_medio_usd).toBeNull();
  });

  it("una fila sin las columnas nuevas cae en false, null y null", async () => {
    const t = await cartera(viejo());

    expect(t).toMatchObject({ autoalta: false, base_estado: null, base_mb: null, costo_medio_usd: null });
  });

  it("el SQL mira la tabla de bases y mide sólo las que puede abrir", async () => {
    await cartera(viejo());

    const dialecto = new PgDialect();
    const campos = h.campos[0] as Record<"autoalta" | "base_estado" | "base_mb", never>;
    expect(dialecto.sqlToQuery(campos.base_estado).sql).toContain("tenant_bases");
    const mb = dialecto.sqlToQuery(campos.base_mb).sql;
    expect(mb).toContain("pg_database_size");
    expect(mb).toContain("has_database_privilege");
    expect(dialecto.sqlToQuery(campos.autoalta).sql).toContain("to_jsonb");
  });
});
