/**
 * One month of a tenant's work, priced — and frozen once the month is over.
 *
 * The arithmetic itself lives in `@/lib/billing/plans` as pure functions. This
 * module is the part that needs the database: counting the period's claims,
 * reading what the AI actually cost, and deciding whether the answer should be
 * recomputed or read back from the day the period closed.
 *
 * WHY FREEZING MATTERS. Recomputing from `cases` is right while the month is
 * running and wrong the moment it ends, because three ordinary things move a
 * closed month's number afterwards:
 *
 *   · cleanup-junk-cases / reset-cases-keep-training delete old rows;
 *   · an analyst corrects a case and `is_claim` flips;
 *   · the tenant changes plan, or the price list is edited.
 *
 * None of those is a bug. Letting them rewrite an invoice that was already sent
 * is. The client who asks for March in June must get March.
 *
 * WHY ON READ, NOT ON A SCHEDULE. Vercel's Hobby plan allows two cron jobs a
 * day and both are taken (gmail-poll, reap-stuck). So the first request for a
 * month that has already ended is what closes it. That is deterministic — the
 * period is over, the inputs cannot legitimately change any more — and it means
 * no month can be missed because a cron did not run.
 */

import "server-only";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { computeInvoice, computeMargin, PLAN_CATALOG, isPlan } from "@/lib/billing/plans";
import type { BillingPeriod } from "@/lib/billing/period";

export interface Statement {
  month: string;
  period: { start: string; end: string };
  tenant: {
    id: string;
    name: string;
    plan: string;
    plan_label: string;
    billing_status: string;
    contact_email: string | null;
    trial_ends_at: string | null;
    activated_at: string | null;
  };
  volume: {
    total_cases: number;
    billable_claims: number;
    rejected_not_a_claim: number;
    unresolved: number;
  };
  invoice: ReturnType<typeof computeInvoice>;
  ai_cost: {
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
    cost_per_billable_claim_usd: number;
  };
  margin: ReturnType<typeof computeMargin>;
  /** True when this is the stored copy of a closed period, not a fresh count. */
  frozen: boolean;
  /** When the period was closed. Null while the month is still running. */
  frozen_at: string | null;
}

/** The statement without the two fields that describe how it was obtained. */
export type StatementCore = Omit<Statement, "frozen" | "frozen_at">;

/** Has this period ended? Only a finished month may be frozen. */
export function periodHasEnded(range: BillingPeriod, now: Date = new Date()): boolean {
  return now.getTime() >= new Date(range.next).getTime();
}

/**
 * Count the period and price it, from live data.
 *
 * Returns null when the tenant does not exist — the caller turns that into a
 * 404 rather than an invoice for nobody.
 */
export async function computeStatement(
  tenantId: string,
  range: BillingPeriod
): Promise<StatementCore | null> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const cases = tables.cases;
  const aiUsage = tables.aiUsage;

  const [tenantRow] = await enTenant(tenantCtx, (db) =>
    db
      .select({
        id: tables.tenants.id,
        name: tables.tenants.name,
        plan: tables.tenants.plan,
        billing_status: tables.tenants.billing_status,
        monthly_fee_usd: tables.tenants.monthly_fee_usd,
        included_claims: tables.tenants.included_claims,
        overage_price_usd: tables.tenants.overage_price_usd,
        contact_email: tables.tenants.contact_email,
        trial_ends_at: tables.tenants.trial_ends_at,
        activated_at: tables.tenants.activated_at,
      })
      .from(tables.tenants)
      .where(eq(tables.tenants.id, tenantId))
      .limit(1)
  );

  if (!tenantRow) return null;

  const inPeriod = and(
    eq(cases.tenant_id, tenantId),
    gte(cases.created_at, range.start),
    lt(cases.created_at, range.next)
  );

  // One pass over the period: every bucket an invoice line might need.
  const [counts] = await enTenant(tenantCtx, (db) =>
    db
      .select({
        total: sql<number>`count(*)::int`,
        billable: sql<number>`count(*) filter (where is_claim is true)::int`,
        rejected: sql<number>`count(*) filter (where is_claim is false)::int`,
        unresolved: sql<number>`count(*) filter (where is_claim is null)::int`,
      })
      .from(cases)
      .where(inPeriod)
  );

  const [spend] = await enTenant(tenantCtx, (db) =>
    db
      .select({
        calls: sql<number>`count(*)::int`,
        prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::int`,
        completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::int`,
        cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
      })
      .from(aiUsage)
      .where(
        and(
          gte(aiUsage.created_at, range.start),
          lt(aiUsage.created_at, range.next)
        )
      )
  );

  // The tenant's stored terms are authoritative — they are what was signed.
  // The catalog only fills in for a row written before migration 0010.
  const fallback = isPlan(tenantRow.plan) ? PLAN_CATALOG[tenantRow.plan] : PLAN_CATALOG.piloto;

  const invoice = computeInvoice({
    claims: counts?.billable ?? 0,
    monthly_fee_usd: Number(tenantRow.monthly_fee_usd ?? fallback.monthly_fee_usd),
    included_claims: Number(tenantRow.included_claims ?? fallback.included_claims),
    overage_price_usd: Number(tenantRow.overage_price_usd ?? fallback.overage_price_usd),
    label: fallback.label,
  });

  const cost = Number(spend?.cost_usd ?? 0);
  const billable = counts?.billable ?? 0;

  return {
    month: range.month,
    period: { start: range.start, end: range.next },
    tenant: {
      id: tenantRow.id,
      name: tenantRow.name,
      plan: tenantRow.plan,
      plan_label: fallback.label,
      billing_status: tenantRow.billing_status,
      contact_email: tenantRow.contact_email,
      trial_ends_at: tenantRow.trial_ends_at,
      activated_at: tenantRow.activated_at,
    },
    volume: {
      total_cases: counts?.total ?? 0,
      billable_claims: billable,
      rejected_not_a_claim: counts?.rejected ?? 0,
      unresolved: counts?.unresolved ?? 0,
    },
    invoice,
    ai_cost: {
      calls: spend?.calls ?? 0,
      prompt_tokens: spend?.prompt_tokens ?? 0,
      completion_tokens: spend?.completion_tokens ?? 0,
      cost_usd: Math.round(cost * 10000) / 10000,
      cost_per_billable_claim_usd:
        billable > 0 ? Math.round((cost / billable) * 10000) / 10000 : 0,
    },
    margin: computeMargin(invoice.total_usd, cost),
  };
}

/** The stored copy of a closed period, or null if it was never closed. */
export async function readFrozenStatement(
  tenantId: string,
  month: string
): Promise<Statement | null> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const [row] = await enTenant(tenantCtx, (db) =>
    db
      .select({
        payload: tables.billingInvoices.payload,
        frozen_at: tables.billingInvoices.frozen_at,
      })
      .from(tables.billingInvoices)
      .where(
        eq(tables.billingInvoices.month, month)
      )
      .limit(1)
  );

  if (!row) return null;

  // The payload is what the API answered the day the period closed. `frozen`
  // is stamped from the row rather than trusted from inside the JSON, so an
  // edited payload cannot claim a closing date it never had.
  return { ...(row.payload as Statement), frozen: true, frozen_at: row.frozen_at };
}

/**
 * The statement for a period: the stored copy if the month is closed, a live
 * count if it is still running, and the act of closing it in between.
 *
 * Idempotent under concurrency. Two simultaneous first-requests for the same
 * closed month both try to insert; the unique constraint lets one win, and both
 * then read the winner back — so nobody can end up holding a second, slightly
 * different version of the same invoice.
 */
export async function getStatement(
  tenantId: string,
  range: BillingPeriod,
  now: Date = new Date()
): Promise<Statement | null> {
  const stored = await readFrozenStatement(tenantId, range.month);
  if (stored) return stored;

  const live = await computeStatement(tenantId, range);
  if (!live) return null;

  if (!periodHasEnded(range, now)) {
    return { ...live, frozen: false, frozen_at: null };
  }

  await enTenant({ tenantId }, (db) =>
    db
      .insert(tables.billingInvoices)
      .values({
        tenant_id: tenantId,
        month: range.month,
        period_start: range.start,
        period_end: range.next,
        billable_claims: live.volume.billable_claims,
        total_usd: live.invoice.total_usd.toFixed(2),
        ai_cost_usd: live.ai_cost.cost_usd.toFixed(4),
        plan: live.tenant.plan,
        monthly_fee_usd: live.invoice.monthly_fee_usd.toFixed(2),
        included_claims: live.invoice.included_claims,
        overage_price_usd: live.invoice.overage_price_usd.toFixed(4),
        payload: { ...live, frozen: true },
      })
      .onConflictDoNothing({
        target: [tables.billingInvoices.tenant_id, tables.billingInvoices.month],
      })
  );

  // Read back rather than return what we just built: under a race the row that
  // survived may be the other request's, and one invoice per month is the whole
  // point. Falling back to the live figure keeps the endpoint answering if the
  // insert was rejected for any other reason.
  return (await readFrozenStatement(tenantId, range.month)) ?? { ...live, frozen: false, frozen_at: null };
}
