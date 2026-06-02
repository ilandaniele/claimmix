/**
 * Customer matcher — finds customers in the DB that match fields extracted
 * from an inbound email.
 *
 * Match priority (highest confidence first):
 *   1. policy_number exact match (per tenant)
 *   2. DNI exact match (per tenant)
 *   3. Email exact match (per tenant)
 *   4. Phone match via customer_contacts
 *
 * AC6:  High-confidence match sets cases.customer_id + cases.policy_id.
 * AC22: Priority: policy > dni > email > phone.
 * IDOR: Uses service-role client — RLS ensures no cross-tenant leakage on the
 *       customer data (tenant_id filter is always applied in SQL).
 *
 * LLM06: PII fields (email, phone, dni) are never logged. Only customer_id
 *        and match_type are logged.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimFields } from "@/lib/schemas/extracted-claim";

/** A single customer match result. */
export interface CustomerMatch {
  /** UUID of the matched customer row. */
  customerId: string;
  /** UUID of the matched policy row (if a policy was the basis of the match). */
  policyId?: string;
  /** The field type that produced the match. */
  matchType: "policy_number" | "dni" | "email" | "phone";
  /** Confidence score assigned to this match type (0.0–1.0). */
  confidence: number;
  /** Full name of the matched customer (PII — used for conflict detection, not logged). */
  customerName: string;
  /**
   * Field keys where extracted value conflicts with the stored customer record.
   * For example: email in email differs from customers.email.
   */
  conflictsWithExtracted: string[];
}

/** Confidence scores by match type. */
const MATCH_CONFIDENCE: Record<CustomerMatch["matchType"], number> = {
  policy_number: 0.95,
  dni: 0.85,
  email: 0.75,
  phone: 0.60,
};

/**
 * Find all customers that match the extracted claim fields.
 *
 * Returns an array of matches sorted by confidence descending.
 * Returns [] if no matches are found.
 *
 * @param supabase  - Supabase client (service role for privileged reads).
 * @param tenantId  - Tenant scope (always applied — prevents cross-tenant leakage).
 * @param fields    - Extracted claim fields from the AI extractor.
 */
export async function findCustomerMatches(
  supabase: SupabaseClient,
  tenantId: string,
  fields: Partial<ClaimFields>
): Promise<CustomerMatch[]> {
  const matches: CustomerMatch[] = [];
  const seenCustomerIds = new Set<string>();

  // ── 1. Policy number match (highest priority) ────────────────────────────────
  if (fields.policy_number && fields.policy_number.trim() !== "") {
    const policyMatches = await matchByPolicyNumber(supabase, tenantId, fields.policy_number.trim(), fields);
    for (const m of policyMatches) {
      if (!seenCustomerIds.has(m.customerId)) {
        matches.push(m);
        seenCustomerIds.add(m.customerId);
      }
    }
  }

  // ── 2. DNI match ──────────────────────────────────────────────────────────────
  if (fields.dni && fields.dni.trim() !== "") {
    const dniMatches = await matchByDni(supabase, tenantId, fields.dni.trim(), fields);
    for (const m of dniMatches) {
      if (!seenCustomerIds.has(m.customerId)) {
        matches.push(m);
        seenCustomerIds.add(m.customerId);
      }
    }
  }

  // ── 3. Email match ─────────────────────────────────────────────────────────────
  if (fields.email && fields.email.trim() !== "") {
    const emailMatches = await matchByEmail(supabase, tenantId, fields.email.trim(), fields);
    for (const m of emailMatches) {
      if (!seenCustomerIds.has(m.customerId)) {
        matches.push(m);
        seenCustomerIds.add(m.customerId);
      }
    }
  }

  // ── 4. Phone match via customer_contacts ──────────────────────────────────────
  if (fields.phone && fields.phone.trim() !== "") {
    const phoneMatches = await matchByPhone(supabase, tenantId, fields.phone.trim(), fields);
    for (const m of phoneMatches) {
      if (!seenCustomerIds.has(m.customerId)) {
        matches.push(m);
        seenCustomerIds.add(m.customerId);
      }
    }
  }

  // Sort by confidence descending (highest first).
  matches.sort((a, b) => b.confidence - a.confidence);

  console.info(
    JSON.stringify({
      level: "info",
      service: "claimmix",
      msg: "customer_matcher.matches_found",
      tenant_id: tenantId,
      match_count: matches.length,
      match_types: matches.map((m) => m.matchType),
    })
  );

  return matches;
}

// ── Private matchers ──────────────────────────────────────────────────────────

async function matchByPolicyNumber(
  supabase: SupabaseClient,
  tenantId: string,
  policyNumber: string,
  fields: Partial<ClaimFields>
): Promise<CustomerMatch[]> {
  const { data, error } = await (supabase as any)
    .from("policies")
    .select("id, customer_id, customers(id, full_name, email, dni)")
    .eq("tenant_id", tenantId)
    .eq("policy_number", policyNumber)
    .limit(5);

  if (error) {
    console.error("[customer-matcher] Policy lookup error:", error.code);
    return [];
  }

  return (data ?? []).map((row: any) => {
    const customer = row.customers;
    const conflicts = detectConflicts(fields, customer);
    return {
      customerId: row.customer_id,
      policyId: row.id,
      matchType: "policy_number" as const,
      confidence: MATCH_CONFIDENCE.policy_number,
      customerName: customer?.full_name ?? "",
      conflictsWithExtracted: conflicts,
    };
  });
}

async function matchByDni(
  supabase: SupabaseClient,
  tenantId: string,
  dni: string,
  fields: Partial<ClaimFields>
): Promise<CustomerMatch[]> {
  const { data, error } = await (supabase as any)
    .from("customers")
    .select("id, full_name, email, dni")
    .eq("tenant_id", tenantId)
    .eq("dni", dni)
    .limit(5);

  if (error) {
    console.error("[customer-matcher] DNI lookup error:", error.code);
    return [];
  }

  return (data ?? []).map((customer: any) => {
    const conflicts = detectConflicts(fields, customer);
    return {
      customerId: customer.id,
      policyId: undefined,
      matchType: "dni" as const,
      confidence: MATCH_CONFIDENCE.dni,
      customerName: customer.full_name ?? "",
      conflictsWithExtracted: conflicts,
    };
  });
}

async function matchByEmail(
  supabase: SupabaseClient,
  tenantId: string,
  email: string,
  fields: Partial<ClaimFields>
): Promise<CustomerMatch[]> {
  const { data, error } = await (supabase as any)
    .from("customers")
    .select("id, full_name, email, dni")
    .eq("tenant_id", tenantId)
    .eq("email", email.toLowerCase())
    .limit(5);

  if (error) {
    console.error("[customer-matcher] Email lookup error:", error.code);
    return [];
  }

  return (data ?? []).map((customer: any) => {
    const conflicts = detectConflicts(fields, customer);
    return {
      customerId: customer.id,
      policyId: undefined,
      matchType: "email" as const,
      confidence: MATCH_CONFIDENCE.email,
      customerName: customer.full_name ?? "",
      conflictsWithExtracted: conflicts,
    };
  });
}

async function matchByPhone(
  supabase: SupabaseClient,
  tenantId: string,
  phone: string,
  fields: Partial<ClaimFields>
): Promise<CustomerMatch[]> {
  // Normalize phone: strip spaces, dashes, parentheses for matching.
  const normalized = phone.replace(/[\s\-().+]/g, "");

  const { data, error } = await (supabase as any)
    .from("customer_contacts")
    .select("customer_id, customers(id, full_name, email, dni)")
    .eq("tenant_id", tenantId)
    .eq("contact_type", "phone")
    .eq("value", phone)
    .limit(5);

  void normalized; // used for logging only; not in SQL (match exact stored value)

  if (error) {
    console.error("[customer-matcher] Phone lookup error:", error.code);
    return [];
  }

  return (data ?? []).map((row: any) => {
    const customer = row.customers;
    const conflicts = detectConflicts(fields, customer);
    return {
      customerId: row.customer_id,
      policyId: undefined,
      matchType: "phone" as const,
      confidence: MATCH_CONFIDENCE.phone,
      customerName: customer?.full_name ?? "",
      conflictsWithExtracted: conflicts,
    };
  });
}

/**
 * Detect fields where the extracted value conflicts with the stored customer record.
 *
 * AC9: Conflict detected when a high-confidence extracted field differs from
 *      the stored customer record value.
 *
 * Returns field keys that conflict (e.g. ["full_name"] when names differ).
 */
function detectConflicts(
  extracted: Partial<ClaimFields>,
  customer: { full_name?: string; email?: string; dni?: string } | null
): string[] {
  if (!customer) return [];
  const conflicts: string[] = [];

  // Check full_name conflict.
  if (
    extracted.full_name &&
    customer.full_name &&
    extracted.full_name.toLowerCase().trim() !== customer.full_name.toLowerCase().trim()
  ) {
    conflicts.push("full_name");
  }

  // Check email conflict.
  if (
    extracted.email &&
    customer.email &&
    extracted.email.toLowerCase().trim() !== customer.email.toLowerCase().trim()
  ) {
    conflicts.push("email");
  }

  // Check DNI conflict.
  if (
    extracted.dni &&
    customer.dni &&
    extracted.dni.replace(/\D/g, "") !== customer.dni.replace(/\D/g, "")
  ) {
    conflicts.push("dni");
  }

  return conflicts;
}
