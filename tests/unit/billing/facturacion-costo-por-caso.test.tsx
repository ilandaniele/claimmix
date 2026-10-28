// @vitest-environment node
/**
 * El costo por caso en /admin/facturacion (ítem 15).
 *
 * La pantalla muestra la mediana, el p95 y la cantidad de casos del mes, a
 * cuatro decimales (un caso cuesta milésimas y con dos se vería US$ 0,00). Una
 * liquidación congelada antes de la 0054 no trae `per_case`: tiene que decir
 * «sin datos» en vez de tirar o mostrar ceros.
 *
 * También el cupo por unidades: la fila del cupo y el excedente salen con
 * decimales y con el separador de es-AR en las dos lenguas, igual que el dinero
 * de la misma tarjeta, y la nota de pesos por canal sale de `PESO_EN_DECIMAS`,
 * sólo en las liquidaciones que los aplicaron.
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
import { computeInvoice, computeMargin, consumoDelMes, PESO_EN_DECIMAS } from "@/lib/billing/plans";
import type { Statement } from "@/server/billing/statement";

const RANGO = resolveBillingPeriod(null)!;

function liquidacion(
  perCase?: { cases: number; median_usd: number; p95_usd: number },
  invoice: Statement["invoice"] = computeInvoice({
    claims: 10,
    monthly_fee_usd: 390,
    included_claims: 750,
    overage_price_usd: 0.45,
    label: "Operativo",
  })
): Statement {
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
    invoice,
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

describe("/admin/facturacion — el cupo por unidades", () => {
  /** Operativo 2027, un mes de canales mezclados: 408 denuncias, 354,9 unidades, 34,9 de excedente. */
  function mezclada(): Statement {
    const { claims, units } = consumoDelMes({ whatsapp: 300, email: 105, whatsapp_propia: 3 });
    return liquidacion(
      undefined,
      computeInvoice({ claims, units, monthly_fee_usd: 390, included_claims: 320, overage_price_usd: 1.3, label: "Operativo" })
    );
  }

  /** Congelada antes de los pesos: sin `units`, un caso era una unidad. */
  function congeladaAntesDeLosPesos(): Statement {
    const invoice = computeInvoice({ claims: 400, monthly_fee_usd: 390, included_claims: 750, overage_price_usd: 0.45, label: "Operativo" });
    delete invoice.units;
    return liquidacion(undefined, invoice);
  }

  it("en es-AR muestra las unidades y el excedente con coma decimal, y la nota de pesos", async () => {
    m.getStatement.mockResolvedValue(mezclada());

    const html = await pintar();

    expect(html).toContain("Unidades del cupo");
    expect(html).toContain("354,9 de 320");
    expect(html).toContain("(34,9 × US$ 1,30)");
    expect(html).toContain("según el canal: WhatsApp 1 · WABA propia 0,8 · mail 0,5 · web 1.");
  });

  it("en en-US los textos van en inglés y los números con el mismo separador que el dinero: una etiqueta no mezcla «34.9» con «US$ 1,30»", async () => {
    m.locale.actual = "en-US";
    m.getStatement.mockResolvedValue(mezclada());

    const html = await pintar();

    expect(html).toContain("Plan units");
    expect(html).toContain("354,9 of 320");
    expect(html).toContain("(34,9 × US$ 1,30)");
    expect(html).toContain("by channel: WhatsApp 1 · own WABA 0,8 · email 0,5 · web 1.");
  });

  it("una liquidación congelada antes de los pesos muestra sus denuncias y no lleva la nota", async () => {
    for (const locale of ["es-AR", "en-US"] as const) {
      m.locale.actual = locale;
      m.getStatement.mockResolvedValue(congeladaAntesDeLosPesos());

      const html = await pintar();

      expect(html).toContain(locale === "es-AR" ? "400 de 750" : "400 of 750");
      expect(html).not.toContain(locale === "es-AR" ? "según el canal" : "by channel");
    }
  });

  it("los pesos de la nota salen de PESO_EN_DECIMAS y no del texto", async () => {
    m.getStatement.mockResolvedValue(mezclada());
    const antes = PESO_EN_DECIMAS.web;
    PESO_EN_DECIMAS.web = 7;
    try {
      expect(await pintar()).toContain("mail 0,5 · web 0,7.");
    } finally {
      PESO_EN_DECIMAS.web = antes;
    }
  });

  it("el texto tiene un marcador por cada canal que pesa: uno nuevo no puede quedar fuera", () => {
    for (const locale of ["es-AR", "en-US"] as const) {
      const texto = getT(locale)("facturacion.pesos");
      for (const cubeta of Object.keys(PESO_EN_DECIMAS)) expect(texto).toContain(`{${cubeta}}`);
    }
  });
});
