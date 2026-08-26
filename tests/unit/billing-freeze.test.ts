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

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

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
    },
    cases: { tenant_id: { name: "tenant_id" }, created_at: { name: "created_at" } },
    aiUsage: {
      tenant_id: { name: "tenant_id" },
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
};

/** Lo que devuelven las tres consultas de un cálculo en vivo, en orden. */
function liveQueries(billable: number, costUsd = 2) {
  return [
    [tenantRow],
    [{ total: billable + 5, billable, rejected: 5, unresolved: 0 }],
    [{ calls: billable, prompt_tokens: 1000, completion_tokens: 100, cost_usd: costUsd }],
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
});
