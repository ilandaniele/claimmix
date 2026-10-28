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

import type { CANALES_REALES } from "@/lib/schemas/cases";
import { topeEntero } from "@/lib/topes";

export const PLANS = ["piloto", "inicial", "operativo", "profesional", "corporativo", "enterprise"] as const;

export type Plan = (typeof PLANS)[number];

/** Los planes que se venden. 'piloto' es la Prueba gratuita: no se activa a mano. */
export const PLANES_COMERCIALES = PLANS.filter((p): p is Exclude<Plan, "piloto"> => p !== "piloto");

export const BILLING_STATUSES = ["trial", "active", "suspended", "churned"] as const;

export type BillingStatus = (typeof BILLING_STATUSES)[number];

/** Un inquilino en estas condiciones no recibe ni manda mensajes, ni invita a nadie: su servicio está cortado. */
export const SIN_SERVICIO: ReadonlySet<string> = new Set<BillingStatus>(["suspended", "churned"]);

export interface PlanTerms {
  /** Fixed monthly fee in USD. */
  monthly_fee_usd: number;
  /** Units covered by the fee each calendar month (a claim spends units by channel, see `PESO_EN_DECIMAS`). */
  included_claims: number;
  /** Price per unit beyond `included_claims`. */
  overage_price_usd: number;
  label: string;
}

/**
 * Default terms per plan; `included_claims` are units of the quota.
 *
 * - `piloto` is the free trial: the days come from ALTA_PRUEBA_DIAS.
 * - `enterprise` is the MONTHLY fee and the floor of a negotiable annual
 *   contract: a starting point, not a quote.
 * - Piloto guiado (manual, no mechanism): the operator activates the plan at half
 *   the fee for 60 days and activates it again by hand at the full fee.
 */
export const PLAN_CATALOG: Record<Plan, PlanTerms> = {
  piloto: {
    monthly_fee_usd: 0,
    included_claims: 50,
    overage_price_usd: 0,
    label: "Piloto",
  },
  inicial: {
    monthly_fee_usd: 19,
    included_claims: 12,
    overage_price_usd: 1.5,
    label: "Inicial",
  },
  operativo: {
    monthly_fee_usd: 390,
    included_claims: 320,
    overage_price_usd: 1.3,
    label: "Operativo",
  },
  profesional: {
    monthly_fee_usd: 1100,
    included_claims: 950,
    overage_price_usd: 1.2,
    label: "Profesional",
  },
  corporativo: {
    monthly_fee_usd: 2900,
    included_claims: 2700,
    overage_price_usd: 1.1,
    label: "Corporativo",
  },
  enterprise: {
    monthly_fee_usd: 8000,
    included_claims: 8000,
    overage_price_usd: 1,
    label: "Enterprise",
  },
};

/** Cada canal real, y el WhatsApp de la WABA propia del cliente, que pesa distinto. */
export type Cubeta = (typeof CANALES_REALES)[number] | "whatsapp_propia";

/**
 * Cuántas unidades del cupo gasta una denuncia, según por dónde entró. En décimas
 * para que la suma quede entera y no arrastre error de coma flotante. `web` pesa 1,
 * como antes de los pesos, hasta que lo decida el dueño. El `Record` obliga a darle
 * peso a cualquier canal real nuevo.
 */
export const PESO_EN_DECIMAS: Record<Cubeta, number> = {
  whatsapp: 10,
  whatsapp_propia: 8,
  email: 5,
  web: 10,
};

/** Denuncias y unidades de un mes a partir de las denuncias de cada cubeta. */
export function consumoDelMes(cuentas: Partial<Record<Cubeta, number>>): { claims: number; units: number } {
  let claims = 0;
  let decimas = 0;
  for (const cubeta of Object.keys(PESO_EN_DECIMAS) as Cubeta[]) {
    const n = cuentas[cubeta];
    const cuenta = Math.floor(n !== undefined && Number.isFinite(n) && n > 0 ? n : 0);
    claims += cuenta;
    decimas += cuenta * PESO_EN_DECIMAS[cubeta];
  }
  return { claims, units: decimas / 10 };
}

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

export function isBillingStatus(value: unknown): value is BillingStatus {
  return typeof value === "string" && (BILLING_STATUSES as readonly string[]).includes(value);
}

export interface InvoiceInput extends PlanTerms {
  /** Billable claims the tenant produced this period. */
  claims: number;
  /** Weighted consumption of the quota (see `consumoDelMes`). Without it, one unit per claim. */
  units?: number;
}

export interface Invoice {
  claims: number;
  /** Quota units consumed. Optional: a frozen invoice written before the weights does not carry it. */
  units?: number;
  included_claims: number;
  /** Units beyond the included allowance. Never negative; the name stays for the frozen payloads. */
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

  // En décimas: los pesos son de a 0,1 y así el excedente fraccionario no arrastra coma flotante.
  const unitsD = Math.round(safe(input.units ?? claims) * 10);
  const overageD = Math.max(0, unitsD - included * 10);
  const overageTotal = toCents((overageD * overagePrice) / 10);
  const total = toCents(monthlyFee + overageTotal);

  return {
    claims,
    units: unitsD / 10,
    included_claims: included,
    overage_claims: overageD / 10,
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

/**
 * Tokens por día que cada plan puede gastar en IA, sumando a todo el inquilino.
 * El piloto se puede bajar o subir con AI_PILOTO_DAILY_TOKEN_CAP.
 */
export const TOPE_DIARIO_TOKENS: Record<Plan, number> = {
  piloto: 500_000,
  // Inerte: el tope sólo corta pruebas y las pruebas son 'piloto'; se fija por el orden creciente.
  inicial: 1_000_000,
  operativo: 5_000_000,
  profesional: 20_000_000,
  corporativo: 50_000_000,
  enterprise: 50_000_000,
};

/** Tokens del p95 por llamada (el promedio medido es 11.771): con el p95 el tope no se pasa. */
export const TOKENS_P95_POR_LLAMADA = 12_730;

/** Un plan que no está en el catálogo cae al tope más chico, el del piloto. */
export function topeDiarioDelPlan(plan: string): number {
  if (isPlan(plan) && plan !== "piloto") return TOPE_DIARIO_TOKENS[plan];
  return topeEntero("AI_PILOTO_DAILY_TOKEN_CAP");
}

/** Cuántas llamadas al modelo caben en un tope diario de tokens (39 para el piloto). */
export function llamadasDiariasDePrueba(tope: number): number {
  return Number.isFinite(tope) && tope > 0 ? Math.floor(tope / TOKENS_P95_POR_LLAMADA) : 0;
}

/** Días que dura la prueba de un espacio que se dio de alta solo. */
export function diasDePrueba(): number {
  return topeEntero("ALTA_PRUEBA_DIAS");
}

/** Las columnas del inquilino que deciden si está en prueba (`autoalta` existe desde la 0048). */
export interface InquilinoEnPrueba {
  billing_status?: string | null;
  trial_ends_at?: string | Date | null;
  autoalta?: boolean | null;
}

/**
 * Prueba sin plan comercial. 'piloto' y 'trial' son los valores por omisión de
 * `tenants`, así que sólo `autoalta` distingue a un alta sola de un inquilino de
 * siempre: sin la columna llega `undefined` y esto da false.
 */
export function enPrueba(t: InquilinoEnPrueba): boolean {
  return t.autoalta === true && t.billing_status === "trial";
}

/**
 * La fecha de fin ya pasó. No mira `autoalta`: quien la use para cortar algo la
 * combina con `enPrueba`. Una fecha ilegible cuenta como vencida.
 */
export function pruebaVencida(t: InquilinoEnPrueba, ahora: Date): boolean {
  if (t.billing_status !== "trial" || t.trial_ends_at == null) return false;
  const fin = new Date(t.trial_ends_at).getTime();
  return Number.isNaN(fin) || fin <= ahora.getTime();
}
