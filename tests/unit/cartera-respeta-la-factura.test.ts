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

vi.mock("@/data/scope", () => import("../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

vi.mock("@/lib/db", async () => {
  // `cases` va de verdad: así el `where` se puede pasar a SQL y mirar el filtro.
  const { cases } = await import("@/lib/db/schema");
  const consulta = () => {
    const filas = colaDeFilas.shift() ?? [];
    const q: Record<string, unknown> = {};
    for (const m of ["from", "groupBy", "orderBy", "innerJoin", "leftJoin", "limit"]) {
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
      cases,
      aiUsage: {
        tenant_id: col("tenant_id"),
        case_id: col("case_id"),
        created_at: col("created_at"),
        prompt_tokens: col("prompt_tokens"),
        completion_tokens: col("completion_tokens"),
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

vi.mock("@/server/ai/budget", () => ({
  getDemoTenantId: () => DEMO,
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { resolveBillingPeriod } from "@/lib/billing/period";
import { CANALES_REALES } from "@/lib/schemas/cases";
import { computeStatement } from "@/server/billing/statement";
import { listTenantSummaries } from "@/server/billing/tenant-summary";

const DEMO = "20000000-0000-0000-0000-000000000002";
const UNO = "10000000-0000-0000-0000-000000000001";
const OTRO = "10000000-0000-0000-0000-000000000002";
const MES = "2026-07";

function tenant(id: string, name: string, createdAt = "2026-01-01T00:00:00.000Z") {
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
    created_at: createdAt,
  };
}

/** Las cuatro consultas, en el orden en que `listTenantSummaries` las hace. */
function baseCon(opts: {
  tenants: ReturnType<typeof tenant>[];
  casos?: Array<{ tenant_id: string; total: number; whatsapp?: number; whatsapp_propia?: number; email?: number; web?: number }>;
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
      casos: [{ tenant_id: UNO, total: 40, whatsapp: 30 }],
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
      casos: [{ tenant_id: UNO, total: 40, whatsapp: 30 }],
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
        { tenant_id: UNO, total: 40, whatsapp: 30 },
        { tenant_id: OTRO, total: 5, whatsapp: 4 },
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
      casos: [{ tenant_id: UNO, total: 40, whatsapp: 30 }],
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

  it("un tenant dado de alta después del mes no aparece en la cartera", async () => {
    // Julio terminó antes de que "La Nueva" existiera: no hay nada que
    // facturarle. "Seguros del Sur" se dio de alta adentro de julio y sí entra.
    baseCon({
      tenants: [
        tenant(UNO, "Seguros del Sur", "2026-07-15T00:00:00.000Z"),
        tenant(OTRO, "La Nueva", "2026-08-01T00:00:00.000Z"),
      ],
    });

    const { tenants } = await listTenantSummaries(MES);

    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.id).toBe(UNO);
  });
});

/** El `where` de la consulta de casos, tal como lo manda Postgres. */
function sqlDeCasos(indice: number): string {
  return new PgDialect().sqlToQuery(wheres[indice] as SQL).sql;
}

describe("la facturación no cuenta casos simulados ni de ensayo", () => {
  const canales = CANALES_REALES.map((c) => `'${c}'`).join(", ");

  /** Las tres consultas de `computeStatement`, en orden. */
  function liquidacionCon(
    casos: { total: number; whatsapp?: number; email?: number; rejected: number; unresolved: number },
    terminos: Partial<ReturnType<typeof tenant>> = {}
  ) {
    colaDeFilas.length = 0;
    colaDeFilas.push(
      [{ ...tenant(UNO, "Seguros del Sur"), ...terminos, activated_at: null }],
      [casos],
      [{ calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 }]
    );
  }

  it("la liquidación del mes cuenta sólo canales reales y deja afuera al ensayo", async () => {
    liquidacionCon({ total: 3, whatsapp: 3, rejected: 0, unresolved: 0 });

    await computeStatement(UNO, resolveBillingPeriod(MES)!);

    // La 1ª consulta es la del tenant; la de casos es la 2ª.
    const where = sqlDeCasos(1);
    expect(where).toContain(`"cases"."channel" in (${canales})`);
    expect(where).toContain("not exists");
    expect(where).toContain('from "claim_messages"');
    // El período sigue acotando: el filtro suma, no reemplaza.
    expect(where).toContain('"cases"."created_at" >=');
    expect(where).toContain('"cases"."created_at" <');
  });

  it("la cartera cuenta sólo canales reales y deja afuera al ensayo", async () => {
    baseCon({ tenants: [tenant(UNO, "Seguros del Sur")] });

    await listTenantSummaries(MES);

    // La 1ª consulta es la de tenants; la de casos es la 2ª.
    const where = sqlDeCasos(1);
    expect(where).toContain(`"cases"."channel" in (${canales})`);
    expect(where).toContain("not exists");
    expect(where).toContain('from "claim_messages"');
    expect(where).toContain('"cases"."created_at" >=');
    expect(where).toContain('"cases"."created_at" <');
  });

  it("la liquidación y la cartera dan el mismo total del mes", async () => {
    // Las dos leen lo que la base les devuelve con el mismo filtro: 30
    // denuncias reales son 100 de abono + 20 excedentes × 2 en las dos pantallas.
    liquidacionCon({ total: 40, whatsapp: 30, rejected: 6, unresolved: 4 });
    const liquidacion = await computeStatement(UNO, resolveBillingPeriod(MES)!);

    baseCon({
      tenants: [tenant(UNO, "Seguros del Sur")],
      casos: [{ tenant_id: UNO, total: 40, whatsapp: 30 }],
    });
    const { tenants } = await listTenantSummaries(MES);

    expect(liquidacion?.invoice.total_usd).toBe(140);
    expect(tenants[0]!.invoice_total_usd).toBe(liquidacion?.invoice.total_usd);
    expect(tenants[0]!.billable_claims).toBe(liquidacion?.volume.billable_claims);
    expect(tenants[0]!.total_cases).toBe(liquidacion?.volume.total_cases);
  });

  it("con canales mezclados las dos pantallas pesan igual: 300 WhatsApp y 50 mails son 325 unidades", async () => {
    // 350 denuncias, 325 unidades sobre 320 incluidas: 5 × US$ 1,30 de excedente.
    const operativo = { monthly_fee_usd: "390", included_claims: 320, overage_price_usd: "1.3" };
    liquidacionCon({ total: 355, whatsapp: 300, email: 50, rejected: 5, unresolved: 0 }, operativo);
    const liquidacion = await computeStatement(UNO, resolveBillingPeriod(MES)!);

    baseCon({
      tenants: [{ ...tenant(UNO, "Seguros del Sur"), ...operativo }],
      casos: [{ tenant_id: UNO, total: 355, whatsapp: 300, email: 50 }],
    });
    const { tenants } = await listTenantSummaries(MES);

    expect(liquidacion?.invoice.units).toBe(325);
    expect(liquidacion?.invoice.overage_claims).toBe(5);
    expect(liquidacion?.invoice.total_usd).toBe(396.5);
    expect(liquidacion?.volume.billable_claims).toBe(350);
    expect(tenants[0]!.invoice_total_usd).toBe(396.5);
    expect(tenants[0]!.billable_claims).toBe(350);
  });

  it("la cartera suma los mails a media unidad: 20 mails caben en un abono de 10", async () => {
    baseCon({
      tenants: [tenant(UNO, "Seguros del Sur")],
      casos: [{ tenant_id: UNO, total: 20, email: 20 }],
    });

    const { tenants } = await listTenantSummaries(MES);

    // 20 mails = 10 unidades = el abono: sin excedente.
    expect(tenants[0]!.billable_claims).toBe(20);
    expect(tenants[0]!.invoice_total_usd).toBe(100);
  });

  it("con la factura congelada, las denuncias salen de la factura y no se vuelven a pesar", async () => {
    baseCon({
      tenants: [tenant(UNO, "Seguros del Sur")],
      casos: [{ tenant_id: UNO, total: 355, whatsapp: 300, email: 50 }],
      facturas: [{ tenant_id: UNO, total_usd: "396.5", billable_claims: 350 }],
    });

    const { tenants } = await listTenantSummaries(MES);

    expect(tenants[0]!.invoice_total_usd).toBe(396.5);
    expect(tenants[0]!.billable_claims).toBe(350);
  });
});
