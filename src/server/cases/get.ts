/**
 * Case detail query — `GET /api/cases/:id`.
 *
 * Returns the full case with related extracted_fields, missing_docs,
 * and the last 20 audit_log entries (sorted descending by created_at).
 *
 * IDOR protection:
 * - Every query filters explicitly by tenant_id (RLS is gone — the
 *   explicit filter is the ONLY tenant boundary).
 * - A case belonging to another tenant returns zero rows.
 * - The route handler converts a missing row to 404 (not 403) to
 *   prevent tenant enumeration (AC10).
 *
 * AC14: Returns extracted_fields[] with per-field confidence, missing_docs[], audit_log[].
 * AC10: Wrong-tenant case returns null (caller returns 404 NOT_FOUND).
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { auditLog, cases, extractedFields, missingDocs } from "@/lib/db/schema";
import type {
  AuditLogRow,
  CaseRow,
  ExtractedFieldRow,
  MissingDocRow,
} from "@/lib/db/types";

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
 * - The case belongs to a different tenant (explicit tenant filter → zero rows).
 *
 * The caller MUST use this null signal to return a 404 response.
 * NEVER return 403 — doing so leaks the existence of the resource
 * to a potential attacker (IDOR enumeration).
 *
 * @param tenantId - Tenant of the authenticated user (explicit tenant boundary).
 * @param caseId   - UUID of the case to fetch.
 */
export async function getCaseDetail(
  tenantId: string,
  caseId: string
): Promise<CaseDetail | null> {
  // ── 1. Fetch the case row (explicitly tenant-scoped) ──────────────────────
  let caseRow: CaseRow | null;
  try {
    caseRow = firstRow(
      await db
        .select()
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.tenant_id, tenantId)))
        .limit(1)
    );
  } catch {
    // Any error here (including invalid uuid) → 404 (never 403).
    return null;
  }

  if (!caseRow) return null;

  // ── 2-4. Fetch related data in parallel (was 3 sequential round-trips) ───
  // Each related query degrades to an empty array on failure — matching the
  // previous behavior where related-query errors were silently ignored.
  const [extractedData, missingDocsData, auditData] = await Promise.all([
    db
      .select()
      .from(extractedFields)
      .where(
        and(
          eq(extractedFields.case_id, caseId),
          eq(extractedFields.tenant_id, tenantId)
        )
      )
      .orderBy(asc(extractedFields.extracted_at))
      .catch(() => [] as ExtractedFieldRow[]),
    db
      .select()
      .from(missingDocs)
      .where(
        and(eq(missingDocs.case_id, caseId), eq(missingDocs.tenant_id, tenantId))
      )
      .orderBy(asc(missingDocs.requested_at))
      .catch(() => [] as MissingDocRow[]),
    db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.target_type, "case"),
          eq(auditLog.target_id, caseId)
        )
      )
      .orderBy(desc(auditLog.created_at))
      .limit(20)
      .catch(() => [] as AuditLogRow[]),
  ]);

  return {
    case: caseRow,
    extracted_fields: extractedData,
    missing_docs: missingDocsData,
    audit_log: auditData as AuditLogRow[],
  };
}
