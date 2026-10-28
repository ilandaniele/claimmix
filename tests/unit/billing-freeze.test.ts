/**
 * Una factura emitida no puede cambiar sola.
 *
 * /api/admin/billing contaba `cases` en cada llamada. Para el mes en curso está
 * bien; para un mes cerrado significa que el número se mueve después de haberlo
 * cobrado — y se mueve por cosas que el producto hace a propósito: limpiar casos
 * viejos, corregir un `is_claim`, cambiar el plan del cliente o editar la lista
 * de precios. Ninguna es un error. Que reescriban marzo en junio, sí.
 *
 * Estos tests fijan las tres reglas: el mes en curso se recalcula, el mes
 * terminado se congela la primera vez que alguien lo pide, y a partir de ahí
 * gana la copia aunque los casos que le dieron origen ya no existan.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const queued: unknown[][] = [];
const inserted: Record<string, unknown>[] = [];

vi.mock("@/data/scope", () => import("../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

vi.mock("server-only", () => ({}));

function builder() {
  const b: Record<string, unknown> = {
    from: () => b,
    where: () => b,
    limit: () => b,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(queued.shift() ?? []).then(res, rej),
  };
  return b;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => builder(),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  },
  tables: {
    tenants: {
      id: { name: "id" },
      name: { name: "name" },
      plan: { name: "plan" },
      billing_status: { name: "billing_status" },
      monthly_fee_usd: { name: "monthly_fee_usd" },
      included_claims: { name: "included_claims" },
      overage_price_usd: { name: "overage_price_usd" },
      contact_email: { name: "contact_email" },
      trial_ends_at: { name: "trial_ends_at" },
      activated_at: { name: "activated_at" },
      created_at: { name: "created_at" },
    },
    cases: {
      id: { name: "id" },
      tenant_id: { name: "tenant_id" },
      created_at: { name: "created_at" },
      channel: { name: "channel" },
    },
    aiUsage: {
      tenant_id: { name: "tenant_id" },
      case_id: { name: "case_id" },
      created_at: { name: "created_at" },
      prompt_tokens: { name: "prompt_tokens" },
      completion_tokens: { name: "completion_tokens" },
      cost_usd: { name: "cost_usd" },
    },
    billingInvoices: {
      tenant_id: { name: "tenant_id" },
      month: { name: "month" },
      payload: { name: "payload" },
      frozen_at: { name: "frozen_at" },
    },
  },
}));

import { getStatement, periodHasEnded } from "@/server/billing/statement";
import { resolveBillingPeriod } from "@/lib/billing/period";
import type { Cubeta } from "@/lib/billing/plans";

const TENANT = "10000000-0000-0000-0000-000000000001";
const MARZO = resolveBillingPeriod("2026-03")!;

/** Un tenant con plan Operativo: US$390 por 750 denuncias, 0,45 el excedente. */
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

/** La fila de conteos del mes: una cuenta por cubeta del cupo, más rechazados y sin resolver. */
function conteos(cubetas: Partial<Record<Cubeta, number>>) {
  const todas = { whatsapp: 0, whatsapp_propia: 0, email: 0, web: 0, ...cubetas };
  const facturables = Object.values(todas).reduce((a, n) => a + n, 0);
  return { total: facturables + 5, ...todas, rejected: 5, unresolved: 0 };
}

/**
 * Lo que devuelven las tres consultas de un cálculo en vivo, en orden. La del
 * gasto trae además un número por caso real del mes (`costos_por_caso`).
 * `billable` son denuncias de WhatsApp (una unidad cada una) salvo que se pasen cubetas.
 */
function liveQueries(
  billable: number,
  costUsd = 2,
  costosPorCaso: unknown = [],
  cubetas: Partial<Record<Cubeta, number>> = { whatsapp: billable }
) {
  return [
    [tenantRow],
    [conteos(cubetas)],
    [
      {
        calls: billable,
        prompt_tokens: 1000,
        completion_tokens: 100,
        cost_usd: costUsd,
        costos_por_caso: costosPorCaso,
      },
    ],
  ];
}

beforeEach(() => {
  queued.length = 0;
  inserted.length = 0;
});

describe("periodHasEnded", () => {
  it("un mes que todavía corre no está terminado", () => {
    expect(periodHasEnded(MARZO, new Date("2026-03-31T23:59:59Z"))).toBe(false);
  });

  it("el primer instante del mes siguiente ya lo cierra", () => {
    // El rango es semiabierto: `next` no pertenece al período, así que apenas
    // llega, marzo terminó. Un ">" en vez de ">=" acá deja el mes sin congelar
    // durante un segundo, y ese segundo es el que va a agarrar el primer
    // pedido automático del día 1.
    expect(periodHasEnded(MARZO, new Date("2026-04-01T00:00:00Z"))).toBe(true);
  });
});

describe("getStatement — el costo por caso", () => {
  it("lo resume en ai_cost.per_case: mediana y p95 de lo que gastó cada caso", async () => {
    queued.push([], ...liveQueries(800, 2, [0.1, 0.3]));

    const s = await getStatement(TENANT, MARZO, new Date("2026-03-15T12:00:00Z"));

    expect(s?.ai_cost.per_case).toEqual({ cases: 2, median_usd: 0.2, p95_usd: 0.29 });
    expect(s?.ai_cost).not.toHaveProperty("costos_por_caso");
  });

  it("sin ningún caso con gasto no hay per_case, y lo demás del gasto queda igual", async () => {
    queued.push([], ...liveQueries(800, 2, []));
    const vacio = await getStatement(TENANT, MARZO, new Date("2026-03-15T12:00:00Z"));
    queued.push([], ...liveQueries(800, 2, null));
    const nulo = await getStatement(TENANT, MARZO, new Date("2026-03-15T12:00:00Z"));

    expect(vacio?.ai_cost.per_case).toBeUndefined();
    expect(nulo?.ai_cost.per_case).toBeUndefined();
    expect(vacio?.ai_cost.cost_usd).toBe(2);
    expect(vacio?.ai_cost.cost_per_billable_claim_usd).toBe(0.0025);
  });

  it("al congelar guarda el resumen y no la lista cruda de costos", async () => {
    queued.push([], ...liveQueries(800, 2, [0.1, 0.3]));
    queued.push([{ payload: { month: "2026-03" }, frozen_at: "2026-04-01T03:00:00.000Z" }]);

    await getStatement(TENANT, MARZO, new Date("2026-04-01T03:00:00Z"));

    const payload = inserted[0]!.payload as { ai_cost: Record<string, unknown> };
    expect(payload.ai_cost.per_case).toEqual({ cases: 2, median_usd: 0.2, p95_usd: 0.29 });
    expect(JSON.stringify(payload)).not.toContain("costos_por_caso");
  });

  it("una factura congelada antes de este cambio (sin per_case) se lee sin tirar y sin recalcular", async () => {
    queued.push([
      {
        payload: { month: "2026-03", ai_cost: { calls: 800, cost_usd: 2 }, invoice: { total_usd: 412.5 } },
        frozen_at: "2026-04-01T03:00:00.000Z",
      },
    ]);

    const s = await getStatement(TENANT, MARZO, new Date("2026-06-10T00:00:00Z"));

    expect(s?.frozen).toBe(true);
    expect(s?.ai_cost.per_case).toBeUndefined();
    expect(inserted).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });
});

describe("getStatement — el cupo por unidades", () => {
  /** Operativo 2027: US$ 390 por 320 unidades, US$ 1,30 la unidad de más. */
  const operativo2027 = { ...tenantRow, included_claims: 320, overage_price_usd: "1.3000" };
  const gasto = { calls: 400, prompt_tokens: 1000, completion_tokens: 100, cost_usd: 2, costos_por_caso: [] };

  it("300 de WhatsApp y 100 mails son 400 denuncias y 350 unidades: 30 de excedente", async () => {
    queued.push([], [operativo2027], [conteos({ whatsapp: 300, email: 100 })], [gasto]);

    const s = await getStatement(TENANT, MARZO, new Date("2026-03-15T12:00:00Z"));

    expect(s?.volume.billable_claims).toBe(400);
    expect(s?.invoice.claims).toBe(400);
    expect(s?.invoice.units).toBe(350);
    expect(s?.invoice.overage_claims).toBe(30);
    // US$ 390 + 30 × US$ 1,30.
    expect(s?.invoice.total_usd).toBe(429);
  });

  it("la WABA propia pesa 0,8 y la web 1", async () => {
    queued.push([], [operativo2027], [conteos({ whatsapp_propia: 10, web: 2 })], [gasto]);

    const s = await getStatement(TENANT, MARZO, new Date("2026-03-15T12:00:00Z"));

    expect(s?.volume.billable_claims).toBe(12);
    expect(s?.invoice.units).toBe(10);
  });

  it("al congelar guarda las denuncias y las unidades", async () => {
    queued.push([], [operativo2027], [conteos({ whatsapp: 300, email: 100 })], [gasto]);
    queued.push([{ payload: { month: "2026-03", invoice: { total_usd: 429 } }, frozen_at: "2026-04-01T03:00:00.000Z" }]);

    await getStatement(TENANT, MARZO, new Date("2026-04-01T03:00:00Z"));

    expect(inserted[0]!.billable_claims).toBe(400);
    expect(inserted[0]!.total_usd).toBe("429.00");
    const payload = inserted[0]!.payload as { invoice: { units: number; overage_claims: number } };
    expect(payload.invoice.units).toBe(350);
    expect(payload.invoice.overage_claims).toBe(30);
  });

  it("una factura congelada antes de los pesos se lee tal cual, sin unidades inventadas ni recálculo", async () => {
    queued.push([
      {
        payload: { month: "2026-03", invoice: { claims: 400, total_usd: 412.5 } },
        frozen_at: "2026-04-01T03:00:00.000Z",
      },
    ]);

    const s = await getStatement(TENANT, MARZO, new Date("2026-06-10T00:00:00Z"));

    expect(s?.invoice.units).toBeUndefined();
    expect(s?.invoice.total_usd).toBe(412.5);
    expect(inserted).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("una factura congelada con unidades las conserva", async () => {
    queued.push([
      {
        payload: { month: "2026-03", invoice: { claims: 400, units: 350, total_usd: 429 } },
        frozen_at: "2026-04-01T03:00:00.000Z",
      },
    ]);

    const s = await getStatement(TENANT, MARZO, new Date("2026-06-10T00:00:00Z"));

    expect(s?.invoice.units).toBe(350);
  });
});

describe("getStatement", () => {
  it("el mes en curso se recalcula y no se guarda", async () => {
    queued.push([], ...liveQueries(800));

    const s = await getStatement(TENANT, MARZO, new Date("2026-03-15T12:00:00Z"));

    expect(s?.frozen).toBe(false);
    expect(s?.frozen_at).toBeNull();
    expect(inserted).toHaveLength(0);
    // 800 denuncias: 750 incluidas + 50 de excedente a 0,45 = 390 + 22,50.
    expect(s?.invoice.total_usd).toBe(412.5);
  });

  it("el mes terminado se congela la primera vez que se pide", async () => {
    queued.push([], ...liveQueries(800));
    // La relectura posterior al insert devuelve la fila recién guardada.
    queued.push([{ payload: { month: "2026-03", invoice: { total_usd: 412.5 } }, frozen_at: "2026-04-01T03:00:00.000Z" }]);

    const s = await getStatement(TENANT, MARZO, new Date("2026-04-01T03:00:00Z"));

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.month).toBe("2026-03");
    expect(inserted[0]!.billable_claims).toBe(800);
    expect(inserted[0]!.total_usd).toBe("412.50");
    // Los términos quedan guardados con la factura, no sólo el total: si el
    // cliente cambia de plan en abril, marzo se tiene que poder explicar igual.
    expect(inserted[0]!.monthly_fee_usd).toBe("390.00");
    expect(inserted[0]!.included_claims).toBe(750);
    expect(inserted[0]!.overage_price_usd).toBe("0.4500");
    expect(s?.frozen).toBe(true);
    expect(s?.frozen_at).toBe("2026-04-01T03:00:00.000Z");
  });

  it("una vez congelado gana la copia, aunque los casos ya no estén", async () => {
    // Sin cálculo en vivo en la cola: si lo intentara, no encontraría nada y el
    // total daría cero. Tiene que devolver lo guardado sin volver a contar.
    queued.push([
      { payload: { month: "2026-03", invoice: { total_usd: 412.5 } }, frozen_at: "2026-04-01T03:00:00.000Z" },
    ]);

    const s = await getStatement(TENANT, MARZO, new Date("2026-06-10T00:00:00Z"));

    expect(s?.invoice.total_usd).toBe(412.5);
    expect(s?.frozen).toBe(true);
    expect(inserted).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("la fecha de cierre sale de la fila, no del contenido guardado", async () => {
    // Defensa contra un payload editado a mano: puede mentir sobre cuándo se
    // cerró, y esa fecha es la que decide si una factura ya se emitió.
    queued.push([
      {
        payload: { month: "2026-03", frozen: false, frozen_at: "1999-01-01T00:00:00.000Z" },
        frozen_at: "2026-04-01T03:00:00.000Z",
      },
    ]);

    const s = await getStatement(TENANT, MARZO, new Date("2026-06-10T00:00:00Z"));

    expect(s?.frozen).toBe(true);
    expect(s?.frozen_at).toBe("2026-04-01T03:00:00.000Z");
  });

  it("un tenant que no existe no produce factura", async () => {
    queued.push([], []); // sin snapshot, sin tenant

    expect(await getStatement(TENANT, MARZO, new Date("2026-04-01T03:00:00Z"))).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it("no congela un mes anterior al alta", async () => {
    queued.push(
      [],
      [{ ...tenantRow, created_at: "2026-04-01T00:00:00.000Z" }],
      [conteos({ whatsapp: 800 })],
      [{ calls: 800, prompt_tokens: 1000, completion_tokens: 100, cost_usd: 2 }]
    );

    const s = await getStatement(TENANT, MARZO, new Date("2026-04-02T00:00:00Z"));

    expect(inserted).toHaveLength(0);
    expect(s?.frozen).toBe(false);
    expect(s?.frozen_at).toBeNull();
    expect(s?.invoice.monthly_fee_usd).toBe(0);
    expect(s?.invoice.total_usd).toBe(0);
    expect(s?.volume.billable_claims).toBe(800);
    expect(s?.invoice.units).toBe(0);
  });

  it("un mes con el alta adentro se congela entero", async () => {
    queued.push(
      [],
      [{ ...tenantRow, created_at: "2026-03-15T00:00:00.000Z" }],
      [conteos({ whatsapp: 800 })],
      [{ calls: 800, prompt_tokens: 1000, completion_tokens: 100, cost_usd: 2 }]
    );
    queued.push([{ payload: { month: "2026-03", invoice: { total_usd: 412.5 } }, frozen_at: "2026-04-01T03:00:00.000Z" }]);

    const s = await getStatement(TENANT, MARZO, new Date("2026-04-01T03:00:00Z"));

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.total_usd).toBe("412.50");
    expect(s?.frozen).toBe(true);
    expect(s?.invoice.total_usd).toBe(412.5);
  });

  it("una factura congelada sin created_at se sigue leyendo", async () => {
    queued.push([
      {
        payload: { month: "2026-03", tenant: { id: TENANT, name: "Aseguradora de prueba" }, invoice: { total_usd: 412.5 } },
        frozen_at: "2026-04-01T03:00:00.000Z",
      },
    ]);

    const s = await getStatement(TENANT, MARZO, new Date("2026-06-10T00:00:00Z"));

    expect(s?.frozen).toBe(true);
    expect(s?.invoice.total_usd).toBe(412.5);
  });
});
