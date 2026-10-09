/**
 * La cartera con una base por cliente (P11).
 *
 * `listTenantSummaries` cruza a todos los inquilinos. Con `BASE_POR_CLIENTE=1` los
 * clientes (`tenants`) y el gasto de IA (la copia global) siguen en control, pero los
 * casos y las facturas congeladas viven en la base de cada uno, así que esas dos
 * lecturas recorren las bases. Sin la bandera es lo de siempre: cuatro consultas a la
 * misma base, y el orden de `cartera-respeta-la-factura.test.ts` no cambia.
 *
 * Una base que no se pudo leer no se saltea: la cartera mostraría el total de los
 * otros clientes como si fuera el de todos.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Lo que contesta control a `select`, en orden: tenants y después el gasto. */
  colaDeControl: [] as unknown[][],
  /** Lo que contesta cada base a `select`, en orden: casos y después facturas. */
  colasDeBase: new Map<string, unknown[][]>(),
  listar: vi.fn(),
  dbDeBase: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/ai/budget", () => ({ getDemoTenantId: () => null }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));

vi.mock("@/lib/db", async () => {
  const { cases } = await import("@/lib/db/schema");
  /** Un `select` que devuelve a sí mismo en cada eslabón y resuelve con la próxima fila de la cola. */
  const selectDe = (cola: () => unknown[][] | undefined) => () => {
    const q: Record<string, unknown> = {};
    for (const m of ["from", "where", "groupBy", "orderBy"]) q[m] = () => q;
    q.then = (resolver: (v: unknown) => unknown, rechazo: (e: unknown) => unknown) => {
      const siguiente = cola()?.shift();
      return (siguiente instanceof Error ? Promise.reject(siguiente) : Promise.resolve(siguiente ?? [])).then(
        resolver,
        rechazo,
      );
    };
    return q;
  };
  const col = (name: string) => ({ name });
  return {
    db: { select: selectDe(() => h.colaDeControl), execute: h.listar },
    dbDeBase: (base: string) => {
      h.dbDeBase(base);
      return { select: selectDe(() => h.colasDeBase.get(base)) };
    },
    tables: {
      tenants: {
        id: col("id"),
        name: col("name"),
        plan: col("plan"),
        billing_status: col("billing_status"),
        monthly_fee_usd: col("monthly_fee_usd"),
        included_claims: col("included_claims"),
        overage_price_usd: col("overage_price_usd"),
        contact_email: col("contact_email"),
        trial_ends_at: col("trial_ends_at"),
        created_at: col("created_at"),
      },
      cases,
      aiUsage: {
        tenant_id: col("tenant_id"),
        created_at: col("created_at"),
        cost_usd: col("cost_usd"),
      },
      billingInvoices: {
        tenant_id: col("tenant_id"),
        month: col("month"),
        total_usd: col("total_usd"),
        billable_claims: col("billable_claims"),
      },
    },
  };
});

import { listTenantSummaries } from "@/server/billing/tenant-summary";

const GUARDADO = process.env.BASE_POR_CLIENTE;

const UNO = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTRO = "11111111-2222-3333-4444-555555555555";
const nombre = (id: string) => `t_${id.replaceAll("-", "")}`;
const MES = "2026-07";

const tenant = (id: string, name: string) => ({
  id,
  name,
  plan: "piloto",
  billing_status: "active",
  monthly_fee_usd: "100",
  included_claims: 10,
  overage_price_usd: "2",
  contact_email: null,
  trial_ends_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
});

/** Control con sus dos lecturas, y las bases `lista` con las suyas. */
function armar(opts: {
  tenants: ReturnType<typeof tenant>[];
  gasto?: Array<{ tenant_id: string; cost_usd: number }>;
  bases: Record<string, { casos?: unknown; facturas?: unknown[] }>;
}) {
  h.colaDeControl.length = 0;
  h.colaDeControl.push(opts.tenants, opts.gasto ?? []);
  h.colasDeBase.clear();
  for (const [id, { casos, facturas }] of Object.entries(opts.bases)) {
    h.colasDeBase.set(nombre(id), [(casos ?? []) as unknown[], (facturas ?? []) as unknown[]]);
  }
  h.listar.mockResolvedValue({ rows: Object.keys(opts.bases).map((tenant_id) => ({ tenant_id })) });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BASE_POR_CLIENTE = "1";
});

afterEach(() => {
  if (GUARDADO === undefined) delete process.env.BASE_POR_CLIENTE;
  else process.env.BASE_POR_CLIENTE = GUARDADO;
});

describe("la cartera con la bandera prendida", () => {
  it("lee los casos y las facturas de la base de cada cliente, y los clientes y el gasto de control", async () => {
    armar({
      tenants: [tenant(UNO, "Seguros del Sur"), tenant(OTRO, "La Segunda")],
      gasto: [
        { tenant_id: UNO, cost_usd: 4 },
        { tenant_id: OTRO, cost_usd: 1 },
      ],
      bases: {
        [UNO]: {
          casos: [{ tenant_id: UNO, total: 40, billable: 30 }],
          facturas: [{ tenant_id: UNO, total_usd: "120", billable_claims: 12 }],
        },
        [OTRO]: { casos: [{ tenant_id: OTRO, total: 5, billable: 4 }] },
      },
    });

    const { tenants } = await listTenantSummaries(MES);

    expect(h.dbDeBase).toHaveBeenCalledWith(nombre(UNO));
    expect(h.dbDeBase).toHaveBeenCalledWith(nombre(OTRO));
    const porId = new Map(tenants.map((t) => [t.id, t]));
    // La factura congelada de una base manda sobre sus casos, y no se le aplica a la otra.
    expect(porId.get(UNO)).toMatchObject({ total_cases: 40, billable_claims: 12, invoice_total_usd: 120, ai_cost_usd: 4 });
    expect(porId.get(OTRO)).toMatchObject({ total_cases: 5, billable_claims: 4, invoice_total_usd: 100, ai_cost_usd: 1 });
  });

  it("si una base no se puede leer, la cartera no se muestra a medias", async () => {
    armar({
      tenants: [tenant(UNO, "Seguros del Sur"), tenant(OTRO, "La Segunda")],
      bases: {
        [UNO]: { casos: [{ tenant_id: UNO, total: 40, billable: 30 }] },
        // El 3D000 de una base borrada: se encola como rechazo de su primera lectura.
        [OTRO]: { casos: Object.assign(new Error("no existe"), { code: "3D000" }) },
      },
    });

    await expect(listTenantSummaries(MES)).rejects.toThrow(/no se pudo leer 1 base/);
  });

  it("sin bases `lista` no hay casos ni facturas que sumar, y los clientes salen igual", async () => {
    armar({ tenants: [tenant(UNO, "Seguros del Sur")], bases: {} });

    const { tenants } = await listTenantSummaries(MES);

    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({ total_cases: 0, invoice_total_usd: 100 });
  });
});

describe("la cartera sin la bandera", () => {
  it("hace las cuatro consultas contra `db` y no recorre ninguna base", async () => {
    delete process.env.BASE_POR_CLIENTE;
    h.colaDeControl.length = 0;
    h.colaDeControl.push(
      [tenant(UNO, "Seguros del Sur")],
      [{ tenant_id: UNO, total: 40, billable: 30 }],
      [],
      [{ tenant_id: UNO, total_usd: "120", billable_claims: 12 }],
    );

    const { tenants } = await listTenantSummaries(MES);

    expect(tenants[0]).toMatchObject({ total_cases: 40, billable_claims: 12, invoice_total_usd: 120 });
    expect(h.listar).not.toHaveBeenCalled();
    expect(h.dbDeBase).not.toHaveBeenCalled();
  });
});
