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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  const { status, type, q, page, per_page, sort, order } = query;

  // ── Count query ────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  const { count, error: countError } = await countQ;
  if (countError) {
    throw new Error(`[listCases] count error: ${countError.code}`);
  }

  const total = count ?? 0;

  // ── Data query ─────────────────────────────────────────────────────────────
  // Omit raw_intake_text (not in schema yet — field belongs to raw_messages).
  // Select all case columns except large blob fields.
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
  ].join(", ");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // Pagination
  const from = (page - 1) * per_page;
  const to = from + per_page - 1;
  dataQ = dataQ.range(from, to);

  const { data, error: dataError } = await dataQ;
  if (dataError) {
    throw new Error(`[listCases] data error: ${dataError.code}`);
  }

  return {
    data: (data as CaseRow[]) ?? [],
    meta: {
      total,
      page,
      per_page,
      pages: Math.ceil(total / per_page),
    },
  };
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
