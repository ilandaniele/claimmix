/**
 * Case detail query — `GET /api/cases/:id`.
 *
 * Returns the full case with related extracted_fields, missing_docs,
 * and the last 20 audit_log entries (sorted descending by created_at).
 *
 * IDOR protection:
 * - Uses the user-scoped Supabase client (anon key + JWT).
 * - RLS policy `tenant_id = current_tenant_id()` ensures that a case
 *   belonging to another tenant returns zero rows.
 * - The route handler converts a missing row to 404 (not 403) to
 *   prevent tenant enumeration (AC10).
 *
 * AC14: Returns extracted_fields[] with per-field confidence, missing_docs[], audit_log[].
 * AC10: Wrong-tenant case returns null (caller returns 404 NOT_FOUND).
 */

 
type AnySupabaseClient = any;
import type { Database } from "@/lib/supabase/types";

type CaseRow = Database["public"]["Tables"]["cases"]["Row"];
type ExtractedFieldRow = Database["public"]["Tables"]["extracted_fields"]["Row"];
type MissingDocRow = Database["public"]["Tables"]["missing_docs"]["Row"];
type AuditLogRow = Database["public"]["Tables"]["audit_log"]["Row"];

export interface CaseDetail {
  case: CaseRow;
  extracted_fields: ExtractedFieldRow[];
  missing_docs: MissingDocRow[];
  audit_log: AuditLogRow[];
}

/**
 * Fetch a case with all related data.
 *
 * Returns null if:
 * - The case does not exist.
 * - The case belongs to a different tenant (RLS returns zero rows).
 *
 * The caller MUST use this null signal to return a 404 response.
 * NEVER return 403 — doing so leaks the existence of the resource
 * to a potential attacker (IDOR enumeration).
 *
 * @param supabase - User-scoped Supabase client (never service role for this query).
 * @param caseId   - UUID of the case to fetch.
 */
export async function getCaseDetail(
  supabase: AnySupabaseClient,
  caseId: string
): Promise<CaseDetail | null> {
  // ── 1. Fetch the case row (RLS-scoped to current tenant) ──────────────────
   
  const { data: caseData, error: caseError } = await (supabase as any)
    .from("cases")
    .select("*")
    .eq("id", caseId)
    .single();

  if (caseError || !caseData) {
    // PGRST116 = "JSON object requested, multiple (or no) rows returned"
    // Any error here (including no rows) → 404 (never 403).
    return null;
  }

  const caseRow = caseData as CaseRow;

  // ── 2-4. Fetch related data in parallel (was 3 sequential round-trips) ───
  const [
    { data: extractedData },
    { data: missingDocsData },
    { data: auditData },
  ] = await Promise.all([
    (supabase as any)
      .from("extracted_fields")
      .select("*")
      .eq("case_id", caseId)
      .order("extracted_at", { ascending: true }),
    (supabase as any)
      .from("missing_docs")
      .select("*")
      .eq("case_id", caseId)
      .order("requested_at", { ascending: true }),
    (supabase as any)
      .from("audit_log")
      .select("*")
      .eq("target_type", "case")
      .eq("target_id", caseId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  return {
    case: caseRow,
    extracted_fields: (extractedData as ExtractedFieldRow[]) ?? [],
    missing_docs: (missingDocsData as MissingDocRow[]) ?? [],
    audit_log: (auditData as AuditLogRow[]) ?? [],
  };
}
