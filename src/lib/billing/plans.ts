/**
 * The commercial price list, and the arithmetic that turns a month of work
 * into an amount owed.
 *
 * Kept free of `server-only`, DB access and I/O on purpose: the invoice
 * calculation is the part that must never be wrong, so it is a pure function
 * over plain numbers and can be tested exhaustively without a database.
 *
 * The catalog mirrors the commercial pricing sheet. A tenant stores its own
 * copy of the terms (tenants.monthly_fee_usd / included_claims /
 * overage_price_usd) rather than only a plan name — a signed contract must not
 * change retroactively because we edited a price here.
 */

export const PLANS = ["piloto", "operativo", "profesional", "corporativo", "enterprise"] as const;

export type Plan = (typeof PLANS)[number];

export const BILLING_STATUSES = ["trial", "active", "suspended", "churned"] as const;

export type BillingStatus = (typeof BILLING_STATUSES)[number];

export interface PlanTerms {
  /** Fixed monthly fee in USD. */
  monthly_fee_usd: number;
  /** Claims covered by the fee each calendar month. */
  included_claims: number;
  /** Price per claim beyond `included_claims`. */
  overage_price_usd: number;
  label: string;
}

/**
 * Default terms per plan. `enterprise` is negotiated per client, so its entry
 * is a floor to start from, not a quote.
 */
export const PLAN_CATALOG: Record<Plan, PlanTerms> = {
  piloto: {
    monthly_fee_usd: 0,
    included_claims: 300,
    overage_price_usd: 0,
    label: "Piloto",
  },
  operativo: {
    monthly_fee_usd: 390,
    included_claims: 750,
    overage_price_usd: 0.45,
    label: "Operativo",
  },
  profesional: {
    monthly_fee_usd: 1100,
    included_claims: 3000,
    overage_price_usd: 0.35,
    label: "Profesional",
  },
  corporativo: {
    monthly_fee_usd: 2900,
    included_claims: 10000,
    overage_price_usd: 0.28,
    label: "Corporativo",
  },
  enterprise: {
    monthly_fee_usd: 2900,
    included_claims: 10000,
    overage_price_usd: 0.2,
    label: "Enterprise",
  },
};

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

export function isBillingStatus(value: unknown): value is BillingStatus {
  return typeof value === "string" && (BILLING_STATUSES as readonly string[]).includes(value);
}

export interface InvoiceInput extends PlanTerms {
  /** Billable claims the tenant produced this period. */
  claims: number;
}

export interface Invoice {
  claims: number;
  included_claims: number;
  /** Claims beyond the included allowance. Never negative. */
  overage_claims: number;
  monthly_fee_usd: number;
  overage_price_usd: number;
  overage_total_usd: number;
  total_usd: number;
  /** Blended price actually paid per claim — 0 when no claims were processed. */
  effective_price_per_claim_usd: number;
}

/** Money is rounded to cents once, at the end, never mid-calculation. */
function toCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Computes one period's invoice.
 *
 * Rounds each money field to cents so the parts always sum to the total — a
 * displayed breakdown that does not add up destroys trust in the whole number.
 * Negative or non-finite inputs are clamped to zero rather than propagating: a
 * bad row in the DB should produce a visibly wrong-but-safe $0, not a credit.
 */
export function computeInvoice(input: InvoiceInput): Invoice {
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

  const claims = Math.floor(safe(input.claims));
  const included = Math.floor(safe(input.included_claims));
  const monthlyFee = safe(input.monthly_fee_usd);
  const overagePrice = safe(input.overage_price_usd);

  const overageClaims = Math.max(0, claims - included);
  const overageTotal = toCents(overageClaims * overagePrice);
  const total = toCents(monthlyFee + overageTotal);

  return {
    claims,
    included_claims: included,
    overage_claims: overageClaims,
    monthly_fee_usd: toCents(monthlyFee),
    overage_price_usd: overagePrice,
    overage_total_usd: overageTotal,
    total_usd: total,
    effective_price_per_claim_usd: claims > 0 ? toCents(total / claims) : 0,
  };
}

/**
 * Gross margin for a period. `costUsd` is the measured AI spend from
 * `ai_usage.cost_usd` — infrastructure and labour are not included, so this is
 * the AI-level margin, which is the one the pricing model is built on.
 *
 * Returns `null` for margin_pct when revenue is zero (a pilot): a percentage of
 * nothing is not "0% margin", it is undefined, and showing 0 would read as a
 * problem where there is none.
 */
export function computeMargin(
  totalUsd: number,
  costUsd: number
): { revenue_usd: number; cost_usd: number; margin_usd: number; margin_pct: number | null } {
  const revenue = toCents(Number.isFinite(totalUsd) && totalUsd > 0 ? totalUsd : 0);
  const cost = toCents(Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0);
  return {
    revenue_usd: revenue,
    cost_usd: cost,
    margin_usd: toCents(revenue - cost),
    margin_pct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null,
  };
}
