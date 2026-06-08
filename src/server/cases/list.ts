/**
 * Cases list query — `GET /api/cases`.
 *
 * Builds the Supabase query for the cases listing endpoint.
 * RLS is enforced by the Supabase client (user-scoped JWT):
 *   - tenant isolation: automatically applied via RLS policy
 *   - IDOR: not applicable to list — users only see their tenant's rows
 *
 * AC9:  List is RLS-isolated by tenant_id.
 * AC11: Filter by claim type returns only matching cases.
 * AC12: Pagination per_page is capped at 100.
 */

 
type AnySupabaseClient = any;
import type { Database } from "@/lib/supabase/types";
import type { CaseQuery } from "@/lib/schemas/cases";

export type CaseRow = Database["public"]["Tables"]["cases"]["Row"];

export interface CaseListResult {
  data: CaseRow[];
  meta: {
    total: number;
    page: number;
    per_page: number;
    pages: number;
  };
}

/**
 * Query cases with filtering, sorting, and pagination.
 *
 * The Supabase client is user-scoped (anon key + JWT) so RLS automatically
 * limits results to the authenticated user's tenant. The caller MUST pass
 * the user-scoped client — never the service-role client — to preserve IDOR safety.
 *
 * raw_intake_text is intentionally NOT selected here (large field, not needed for list).
 */
export async function listCases(
  supabase: AnySupabaseClient,
  query: CaseQuery
): Promise<CaseListResult> {
  const {
    status,
    type,
    q,
    page,
    per_page,
    sort,
    order,
    // AC18: New email-intake filters
    severity,
    customer_id,
    policy_id,
    channel,
    is_claim,
  } = query;

  // ── Count query ────────────────────────────────────────────────────────────

  let countQ = (supabase as any)
    .from("cases")
    .select("id", { count: "exact", head: true });

  if (status) countQ = countQ.eq("status", status);
  if (type) countQ = countQ.eq("claim_type", type);
  if (q) {
    // Full-text search on policyholder_name and policy_number using ilike.
    // Parameterized via Supabase client — no raw SQL string interpolation.
    countQ = countQ.or(
      `policyholder_name.ilike.%${q}%,policy_number.ilike.%${q}%`
    );
  }
  // AC18: Email-intake filters
  if (severity) countQ = countQ.eq("severity", severity);
  if (customer_id) countQ = countQ.eq("customer_id", customer_id);
  if (policy_id) countQ = countQ.eq("policy_id", policy_id);
  if (channel) countQ = countQ.eq("channel", channel);
  if (is_claim !== undefined) countQ = countQ.eq("is_claim", is_claim);

  const { count, error: countError } = await countQ;
  if (countError) {
    throw new Error(`[listCases] count error: ${countError.code}`);
  }

  const total = count ?? 0;

  // ── Data query ─────────────────────────────────────────────────────────────
  // Select core case columns + email-intake columns added in 0005/0006.
  const selectColumns = [
    "id",
    "tenant_id",
    "policy_number",
    "policyholder_name",
    "claim_type",
    "status",
    "confidence_min",
    "assigned_to",
    "channel",
    "created_at",
    "updated_at",
    "closed_at",
    // Email-intake columns (0005, 0006)
    "severity",
    "customer_id",
    "policy_id",
    "email_message_id",
    "email_thread_id",
    "is_claim",
    "not_relevant_reason",
    "requires_specialist",
    "core_external_id",
    "core_error_message",
    "core_sent_at",
  ].join(", ");


  let dataQ = (supabase as any)
    .from("cases")
    .select(selectColumns)
    .order(sort, { ascending: order === "asc" });

  if (status) dataQ = dataQ.eq("status", status);
  if (type) dataQ = dataQ.eq("claim_type", type);
  if (q) {
    dataQ = dataQ.or(
      `policyholder_name.ilike.%${q}%,policy_number.ilike.%${q}%`
    );
  }
  // AC18: Email-intake filters
  if (severity) dataQ = dataQ.eq("severity", severity);
  if (customer_id) dataQ = dataQ.eq("customer_id", customer_id);
  if (policy_id) dataQ = dataQ.eq("policy_id", policy_id);
  if (channel) dataQ = dataQ.eq("channel", channel);
  if (is_claim !== undefined) dataQ = dataQ.eq("is_claim", is_claim);

  // Pagination — max 100 per page (enforced in CaseQuerySchema)
  const from = (page - 1) * per_page;
  const to = from + per_page - 1;
  dataQ = dataQ.range(from, to);

  const { data, error: dataError } = await dataQ;
  if (dataError) {
    throw new Error(`[listCases] data error: ${dataError.code}`);
  }

  const rows = await hydrateCaseListIdentity(
    supabase,
    ((data as CaseRow[]) ?? [])
  );

  return {
    data: rows,
    meta: {
      total,
      page,
      per_page,
      pages: Math.ceil(total / per_page),
    },
  };
}

async function hydrateCaseListIdentity(
  supabase: AnySupabaseClient,
  rows: CaseRow[]
): Promise<CaseRow[]> {
  const caseIdsNeedingHydration = rows
    .filter((row) => !row.policyholder_name || !row.policy_number)
    .map((row) => row.id);

  if (caseIdsNeedingHydration.length === 0) return rows;

  const extractedFieldsQuery = (supabase as any)
    .from("extracted_fields")
    .select("case_id,field_key,field_value");

  if (typeof extractedFieldsQuery.in !== "function") return rows;

  const { data, error } = await extractedFieldsQuery
    .in("case_id", caseIdsNeedingHydration)
    .in("field_key", ["full_name", "policy_number"]);

  if (error || !data) {
    if (error) {
      console.error("[listCases] extracted_fields hydration error:", error.code);
    }
    return rows;
  }

  const fieldsByCase = new Map<string, Record<string, string>>();
  for (const field of data as Array<{ case_id: string; field_key: string; field_value: string }>) {
    const entry = fieldsByCase.get(field.case_id) ?? {};
    entry[field.field_key] = field.field_value;
    fieldsByCase.set(field.case_id, entry);
  }

  return rows.map((row) => {
    const fields = fieldsByCase.get(row.id);
    if (!fields) return row;
    return {
      ...row,
      policyholder_name: row.policyholder_name ?? fields.full_name ?? null,
      policy_number: row.policy_number ?? fields.policy_number ?? null,
    };
  });
}

/**
 * Query cases for CSV export (up to 1000 rows, no pagination offset).
 * Accepts the same filters as listCases but ignores page/per_page.
 *
 * AC13: Same tenant isolation (RLS) as the list endpoint.
 */
export async function listCasesForExport(
  supabase: AnySupabaseClient,
  query: Omit<CaseQuery, "page" | "per_page" | "sort" | "order">
): Promise<CaseRow[]> {
  const { status, type, q } = query;

  const selectColumns = [
    "id",
    "policy_number",
    "policyholder_name",
    "claim_type",
    "status",
    "confidence_min",
    "assigned_to",
    "channel",
    "created_at",
  ].join(", ");

  // Max 1000 rows per export — range 0..999
   
  let q2 = (supabase as any)
    .from("cases")
    .select(selectColumns)
    .order("created_at", { ascending: false })
    .range(0, 999);

  if (status) q2 = q2.eq("status", status);
  if (type) q2 = q2.eq("claim_type", type);
  if (q) {
    q2 = q2.or(`policyholder_name.ilike.%${q}%,policy_number.ilike.%${q}%`);
  }

  const { data, error } = await q2;
  if (error) {
    throw new Error(`[listCasesForExport] error: ${error.code}`);
  }

  return (data as CaseRow[]) ?? [];
}
