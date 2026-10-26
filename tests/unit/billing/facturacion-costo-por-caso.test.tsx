// @vitest-environment node
/**
 * El costo por caso en /admin/facturacion (ítem 15).
 *
 * La pantalla muestra la mediana, el p95 y la cantidad de casos del mes, a
 * cuatro decimales (un caso cuesta milésimas y con dos se vería US$ 0,00). Una
 * liquidación congelada antes de la 0054 no trae `per_case`: tiene que decir
 * «sin datos» en vez de tirar o mostrar ceros.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getStatement: vi.fn(),
  locale: { actual: "es-AR" as "es-AR" | "en-US" },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "accept-language": "es-AR" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth/require-admin", () => ({
  requireAdmin: async () => ({ userRow: { tenant_id: "10000000-0000-0000-0000-000000000001" } }),
}));
vi.mock("@/server/billing/statement", () => ({ getStatement: m.getStatement }));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: async () => m.locale.actual }));

import { resolveBillingPeriod } from "@/lib/billing/period";
import { getT } from "@/lib/i18n";
import { computeInvoice, computeMargin } from "@/lib/billing/plans";
import type { Statement } from "@/server/billing/statement";

const RANGO = resolveBillingPeriod(null)!;

function liquidacion(perCase?: { cases: number; median_usd: number; p95_usd: number }): Statement {
  return {
    month: RANGO.month,
    period: { start: RANGO.start, end: RANGO.next },
    tenant: {
      id: "10000000-0000-0000-0000-000000000001",
      name: "Aseguradora de prueba",
      plan: "operativo",
      plan_label: "Operativo",
      billing_status: "active",
      contact_email: null,
      trial_ends_at: null,
      activated_at: null,
      created_at: "2020-01-01T00:00:00.000Z",
    },
    volume: { total_cases: 12, billable_claims: 10, rejected_not_a_claim: 2, unresolved: 0 },
    invoice: computeInvoice({
      claims: 10,
      monthly_fee_usd: 390,
      included_claims: 750,
      overage_price_usd: 0.45,
      label: "Operativo",
    }),
    ai_cost: {
      calls: 40,
      prompt_tokens: 1000,
      completion_tokens: 100,
      cost_usd: 0.5,
      cost_per_billable_claim_usd: 0.05,
      ...(perCase ? { per_case: perCase } : {}),
    },
    margin: computeMargin(390, 0.5),
    frozen: false,
    frozen_at: null,
  };
}

async function pintar(): Promise<string> {
  const { default: Pagina } = await import("@/app/(app)/admin/facturacion/page");
  return renderToStaticMarkup(await Pagina({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  m.getStatement.mockReset();
  m.locale.actual = "es-AR";
});

describe("/admin/facturacion — costo por caso", () => {
  it("muestra la mediana, el p95 y los casos, con cuatro decimales, y la nota de precio de lista", async () => {
    m.getStatement.mockResolvedValue(liquidacion({ cases: 7, median_usd: 0.0042, p95_usd: 0.031 }));

    const html = await pintar();

    expect(html).toContain("Costo por caso (mediana · p95 · casos)");
    expect(html).toContain("US$\u00a00,0042");
    expect(html).toContain("US$\u00a00,031");
    expect(html).toMatch(/0,031[^<]*· 7</);
    expect(html).toContain("Estimado a precio de lista de Gemini");
    expect(html).not.toContain("sin datos de costo por caso en este período");
  });

  it("una liquidación congelada antes de la 0054 (sin per_case) dice «sin datos» y no tira", async () => {
    m.getStatement.mockResolvedValue(liquidacion());

    const html = await pintar();

    expect(html).toContain("Costo por caso (mediana · p95 · casos)");
    expect(html).toContain("sin datos de costo por caso en este período");
  });

  it("en en-US salen los textos en inglés", async () => {
    m.locale.actual = "en-US";
    m.getStatement.mockResolvedValue(liquidacion({ cases: 7, median_usd: 0.0042, p95_usd: 0.031 }));

    const html = await pintar();

    expect(html).toContain("Cost per case (median · p95 · cases)");
    expect(html).toContain("Estimated at Gemini list price");
    expect(html).not.toContain("Costo por caso");
  });

  it("en en-US y sin datos también", async () => {
    m.locale.actual = "en-US";
    m.getStatement.mockResolvedValue(liquidacion());

    expect(await pintar()).toContain("no per-case cost data for this period");
  });

  it("los textos no nombran «este mes»: la pantalla también abre meses pasados y facturas viejas sin el dato", () => {
    for (const locale of ["es-AR", "en-US"] as const) {
      const t = getT(locale);
      for (const clave of ["facturacion.costoPorCasoDetalle", "facturacion.costoPorCasoSinDatos"] as const) {
        expect(t(clave)).not.toMatch(/este mes|this month/i);
      }
    }
  });
});
