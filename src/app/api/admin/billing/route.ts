/**
 * GET /api/admin/billing?month=YYYY-MM
 *
 * What to invoice this tenant for a calendar month, and what it cost us to
 * serve them. Admin-only, scoped to the caller's own tenant by an explicit
 * tenant_id filter on every query.
 *
 * BILLABLE UNIT: a claim the agent actually recognised as a claim
 * (`cases.is_claim = true`). Mail the agent correctly rejected as
 * not-a-claim is NOT billed — charging for filtered spam would make the
 * filter look like a revenue source instead of a feature. Cases that never
 * produced a verdict (failed or still processing) are not billed either.
 *
 * The full breakdown is returned, not just the billable number, so an invoice
 * can be defended line by line when a client questions it.
 *
 * No PII is returned — counts and money only.
 */

import { ok, err } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/require-admin";
import { db, tables } from "@/lib/db";
import { computeInvoice, computeMargin, PLAN_CATALOG, isPlan } from "@/lib/billing/plans";
import { resolveBillingPeriod } from "@/lib/billing/period";
import { and, eq, gte, lt, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { userRow } = await requireAdmin();
    const tenantId = userRow.tenant_id;

    const range = resolveBillingPeriod(new URL(request.url).searchParams.get("month"));
    if (!range) {
      return err(new Error("INVALID_MONTH: expected format YYYY-MM"));
    }

    const cases = tables.cases;
    const aiUsage = tables.aiUsage;

    const [tenantRow] = await db
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
      .limit(1);

    if (!tenantRow) {
      return err(new Error("TENANT_NOT_FOUND"));
    }

    const inPeriod = and(
      eq(cases.tenant_id, tenantId),
      gte(cases.created_at, range.start),
      lt(cases.created_at, range.next)
    );

    // One pass over the period: every bucket an invoice line might need.
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        billable: sql<number>`count(*) filter (where is_claim is true)::int`,
        rejected: sql<number>`count(*) filter (where is_claim is false)::int`,
        unresolved: sql<number>`count(*) filter (where is_claim is null)::int`,
      })
      .from(cases)
      .where(inPeriod);

    const [spend] = await db
      .select({
        calls: sql<number>`count(*)::int`,
        prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::int`,
        completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::int`,
        cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.tenant_id, tenantId),
          gte(aiUsage.created_at, range.start),
          lt(aiUsage.created_at, range.next)
        )
      );

    // The tenant's stored terms are authoritative — they are what was signed.
    // The catalog only fills in for a row written before migration 0010.
    const fallback = isPlan(tenantRow.plan)
      ? PLAN_CATALOG[tenantRow.plan]
      : PLAN_CATALOG.piloto;

    const invoice = computeInvoice({
      claims: counts?.billable ?? 0,
      monthly_fee_usd: Number(tenantRow.monthly_fee_usd ?? fallback.monthly_fee_usd),
      included_claims: Number(tenantRow.included_claims ?? fallback.included_claims),
      overage_price_usd: Number(tenantRow.overage_price_usd ?? fallback.overage_price_usd),
      label: fallback.label,
    });

    const cost = Number(spend?.cost_usd ?? 0);

    return ok({
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
        billable_claims: counts?.billable ?? 0,
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
          (counts?.billable ?? 0) > 0
            ? Math.round((cost / (counts?.billable ?? 1)) * 10000) / 10000
            : 0,
      },
      margin: computeMargin(invoice.total_usd, cost),
    });
  } catch (e) {
    return err(e);
  }
}
