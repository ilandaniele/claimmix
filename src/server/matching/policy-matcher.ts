/**
 * Policy matcher — finds policies linked to a customer or by policy number.
 *
 * AC6:  policy_number match sets cases.policy_id.
 * AC22: Policy match has the highest confidence (0.95).
 *
 * Uses service-role client — tenant_id filter is always applied.
 * IDOR: Cross-tenant leakage is prevented by the tenant_id column filter.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** A single policy match result. */
export interface PolicyMatch {
  /** UUID of the matched policy row. */
  policyId: string;
  /** Human-readable policy number (PII — not logged). */
  policyNumber: string;
  /** Policy type: auto, home, life, business, other. */
  policyType: string;
  /** Policy status: active, expired, cancelled. */
  status: "active" | "expired" | "cancelled" | string;
  /** Full name of the policyholder (PII — not logged). */
  customerName: string;
  /** Confidence score: active policies rank higher than expired/cancelled. */
  confidence: number;
}

/**
 * Find policies by policy number (exact match) and/or by customer ID.
 *
 * @param supabase      - Supabase client (service role for privileged reads).
 * @param tenantId      - Tenant scope (always applied).
 * @param policyNumber  - Optional policy number for exact-match lookup.
 * @param customerId    - Optional customer UUID — returns all policies for this customer.
 */
export async function findPolicyMatches(
  supabase: SupabaseClient,
  tenantId: string,
  policyNumber?: string,
  customerId?: string
): Promise<PolicyMatch[]> {
  const results: PolicyMatch[] = [];

  // ── 1. Policy number exact match ──────────────────────────────────────────────
  if (policyNumber && policyNumber.trim() !== "") {
    const matches = await matchByPolicyNumber(supabase, tenantId, policyNumber.trim());
    results.push(...matches);
  }

  // ── 2. Customer-based policy lookup ───────────────────────────────────────────
  if (customerId && customerId.trim() !== "") {
    const seenPolicyIds = new Set(results.map((r) => r.policyId));
    const customerMatches = await matchByCustomerId(supabase, tenantId, customerId.trim());
    for (const m of customerMatches) {
      if (!seenPolicyIds.has(m.policyId)) {
        results.push(m);
        seenPolicyIds.add(m.policyId);
      }
    }
  }

  // Sort: active policies first, then by confidence desc.
  results.sort((a, b) => {
    // Active policies rank higher than expired/cancelled.
    if (a.status === "active" && b.status !== "active") return -1;
    if (b.status === "active" && a.status !== "active") return 1;
    return b.confidence - a.confidence;
  });

  console.info(
    JSON.stringify({
      level: "info",
      service: "claimmix",
      msg: "policy_matcher.matches_found",
      tenant_id: tenantId,
      match_count: results.length,
    })
  );

  return results;
}

// ── Private matchers ──────────────────────────────────────────────────────────

async function matchByPolicyNumber(
  supabase: SupabaseClient,
  tenantId: string,
  policyNumber: string
): Promise<PolicyMatch[]> {
  const { data, error } = await (supabase as any)
    .from("policies")
    .select("id, policy_number, policy_type, status, customers(full_name)")
    .eq("tenant_id", tenantId)
    .eq("policy_number", policyNumber)
    .limit(5);

  if (error) {
    console.error("[policy-matcher] Policy number lookup error:", error.code);
    return [];
  }

  return (data ?? []).map((row: any) => {
    // Active policy number match → highest confidence.
    const confidence = row.status === "active" ? 0.95 : 0.70;
    return {
      policyId: row.id,
      policyNumber: row.policy_number,
      policyType: row.policy_type ?? "other",
      status: row.status,
      customerName: row.customers?.full_name ?? "",
      confidence,
    };
  });
}

async function matchByCustomerId(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string
): Promise<PolicyMatch[]> {
  const { data, error } = await (supabase as any)
    .from("policies")
    .select("id, policy_number, policy_type, status, customers(full_name)")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .order("status", { ascending: true }) // 'active' < 'cancelled' < 'expired' alphabetically
    .limit(20);

  if (error) {
    console.error("[policy-matcher] Customer policy lookup error:", error.code);
    return [];
  }

  return (data ?? []).map((row: any) => {
    // Active = 0.85 (good match from customer link, not direct policy number).
    // Expired/cancelled = 0.60 (lower — may not be the right policy for the claim).
    const confidence = row.status === "active" ? 0.85 : 0.60;
    return {
      policyId: row.id,
      policyNumber: row.policy_number,
      policyType: row.policy_type ?? "other",
      status: row.status,
      customerName: row.customers?.full_name ?? "",
      confidence,
    };
  });
}
