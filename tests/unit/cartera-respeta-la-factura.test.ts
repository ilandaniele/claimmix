/**
 * La cartera contradecía la factura que ya se había mandado.
 *
 * `/admin/facturacion` congela la liquidación de un mes cerrado en
 * `billing_invoices` —una por mes, y desde entonces se lee y no se recalcula: la
 * regla está decidida y escrita en `statement.ts`—. La pantalla de cartera, en
 * cambio, recalculaba SIEMPRE desde `cases` en vivo.
 *
 * Así que basta con que alguien corrija un caso de julio en agosto —marcarlo como
 * no-denuncia, cerrarlo mal, borrarlo— para que la cartera muestre un total
 * distinto del que la aseguradora tiene en la mano. Dos pantallas del mismo
 * producto diciendo dos números del mismo mes, las dos con cara de ser la
 * respuesta y ninguna diciendo cuál manda.
 *
 * ── Por qué este archivo se reescribió ──────────────────────────────────────
 *
 * Porque no probaba el código: leía `tenant-summary.ts` como TEXTO y buscaba
 * `"Number(facturada.total_usd)"` adentro. Un test así pasa con los ternarios
 * invertidos, pasa si la factura de una aseguradora se le aplica a otra, y pasa
 * con el archivo entero comentado abajo de esas cadenas. `tenant-summary.ts`
 * tenía 0 % de cobertura y esto es lo que la sostenía — la plata del producto,
 * verificada con un `grep`.
 *
 * Ahora se ejecuta. La base se simula a nivel de consulta y las cuentas las hace
 * `computeInvoice`/`computeMargin` de verdad.
 */

vi.mock("server-only", () => ({}));

const { colaDeFilas } = vi.hoisted(() => ({ colaDeFilas: [] as unknown[][] }));

/**
 * Una base que contesta, en orden, lo que la cola le puso.
 *
 * `listTenantSummaries` hace cuatro consultas y cada una encadena distinto
 * —`orderBy`, `groupBy`, sólo `where`—, así que el objeto devuelve siempre a sí
 * mismo y recién resuelve cuando lo esperan. `where` guarda su argumento para
 * poder preguntarle si excluyó a la demo.
 */
const wheres: unknown[] = [];

vi.mock("@/lib/db", () => {
  const consulta = () => {
    const filas = colaDeFilas.shift() ?? [];
    const q: Record<string, unknown> = {};
    for (const m of ["from", "groupBy", "orderBy", "innerJoin", "leftJoin"]) {
      q[m] = () => q;
    }
    q.where = (w: unknown) => {
      wheres.push(w);
      return q;
    };
    q.then = (resolver: (v: unknown) => unknown) => Promise.resolve(filas).then(resolver);
    return q;
  };
  const col = (name: string) => ({ name });
  return {
    db: { select: () => consulta() },
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
      cases: { tenant_id: col("tenant_id"), created_at: col("created_at"), is_claim: col("is_claim") },
      aiUsage: { tenant_id: col("tenant_id"), created_at: col("created_at"), cost_usd: col("cost_usd") },
      billingInvoices: {
        tenant_id: col("tenant_id"),
        month: col("month"),
        total_usd: col("total_usd"),
        billable_claims: col("billable_claims"),
      },
    },
  };
});

vi.mock("@/server/ai/budget", () => ({
  getDemoTenantId: () => DEMO,
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { listTenantSummaries } from "@/server/billing/tenant-summary";

const DEMO = "20000000-0000-0000-0000-000000000002";
const UNO = "10000000-0000-0000-0000-000000000001";
const OTRO = "10000000-0000-0000-0000-000000000002";
const MES = "2026-07";

function tenant(id: string, name: string) {
  return {
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
  };
}

/** Las cuatro consultas, en el orden en que `listTenantSummaries` las hace. */
function baseCon(opts: {
  tenants: ReturnType<typeof tenant>[];
  casos?: Array<{ tenant_id: string; total: number; billable: number }>;
  gasto?: Array<{ tenant_id: string; cost_usd: number }>;
  facturas?: Array<{ tenant_id: string; total_usd: string; billable_claims: number }>;
}) {
  colaDeFilas.length = 0;
  colaDeFilas.push(
    opts.tenants,
    opts.casos ?? [],
    opts.gasto ?? [],
    opts.facturas ?? []
  );
}

beforeEach(() => {
  colaDeFilas.length = 0;
  wheres.length = 0;
});

describe("la cartera lee la factura congelada", () => {
  it("cuando el mes ya se facturó, el total y las denuncias salen de la factura", async () => {
    // Los casos en vivo dicen 30 denuncias (= 100 + 20×2 = 140); la factura
    // emitida dice 12 y 120. Manda la factura.
    baseCon({
      tenants: [tenant(UNO, "Seguros del Sur")],
      casos: [{ tenant_id: UNO, total: 40, billable: 30 }],
      facturas: [{ tenant_id: UNO, total_usd: "120", billable_claims: 12 }],
    });

    const { tenants } = await listTenantSummaries(MES);

    expect(tenants[0]!.invoice_total_usd).toBe(120);
    expect(tenants[0]!.billable_claims).toBe(12);
    // El conteo total de casos NO es facturación: sigue siendo el de la base.
    expect(tenants[0]!.total_cases).toBe(40);
  });

  it("y cuando NO hay factura, recalcula desde los casos", async () => {
    baseCon({
      tenants: [tenant(UNO, "Seguros del Sur")],
      casos: [{ tenant_id: UNO, total: 40, billable: 30 }],
    });

    const { tenants } = await listTenantSummaries(MES);

    expect(tenants[0]!.billable_claims).toBe(30);
    // 100 de abono + 20 excedentes × 2.
    expect(tenants[0]!.invoice_total_usd).toBe(140);
  });

  it("la factura de una aseguradora no se le aplica a otra", async () => {
    // Esto es lo que un test que lee el archivo como texto NO puede ver, y es
    // el peor error posible en esta pantalla: el número de un cliente en la
    // fila de otro.
    baseCon({
      tenants: [tenant(UNO, "Seguros del Sur"), tenant(OTRO, "La Segunda")],
      casos: [
        { tenant_id: UNO, total: 40, billable: 30 },
        { tenant_id: OTRO, total: 5, billable: 4 },
      ],
      facturas: [{ tenant_id: UNO, total_usd: "120", billable_claims: 12 }],
    });

    const { tenants } = await listTenantSummaries(MES);

    expect(tenants[0]!.invoice_total_usd).toBe(120);
    // El segundo no tiene factura: 4 denuncias, todas dentro del abono.
    expect(tenants[1]!.invoice_total_usd).toBe(100);
    expect(tenants[1]!.billable_claims).toBe(4);
  });

  it("el margen se calcula contra el total que de verdad se cobró", async () => {
    // Con el recálculo (140) el margen sería 50 %; con la factura (120), 41,67 %.
    baseCon({
      tenants: [tenant(UNO, "Seguros del Sur")],
      casos: [{ tenant_id: UNO, total: 40, billable: 30 }],
      gasto: [{ tenant_id: UNO, cost_usd: 70 }],
      facturas: [{ tenant_id: UNO, total_usd: "120", billable_claims: 12 }],
    });

    const { tenants } = await listTenantSummaries(MES);

    expect(tenants[0]!.ai_cost_usd).toBe(70);
    expect(tenants[0]!.margin_pct).toBeCloseTo(41.67, 1);
  });

  it("el tenant de la demo no entra en la cartera", async () => {
    // No es un cliente: no tiene contrato y su gasto lo paga la casa. Sumarlo
    // hace que el número de clientes y el de margen mientan los dos a la vez.
    baseCon({ tenants: [tenant(UNO, "Seguros del Sur")] });

    await listTenantSummaries(MES);

    // La exclusión va en el `where` de la consulta de tenants, que es la 1ª.
    expect(JSON.stringify(wheres[0] ?? {})).toContain(DEMO);
  });

  it("un tenant sin casos ni gasto no rompe la fila", async () => {
    baseCon({ tenants: [tenant(UNO, "Seguros del Sur")] });

    const { tenants, month } = await listTenantSummaries(MES);

    expect(month).toBe(MES);
    expect(tenants[0]!.billable_claims).toBe(0);
    expect(tenants[0]!.total_cases).toBe(0);
    expect(tenants[0]!.ai_cost_usd).toBe(0);
    expect(tenants[0]!.invoice_total_usd).toBe(100);
  });
});
