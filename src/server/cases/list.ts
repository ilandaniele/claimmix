/**
 * Cases list query — `GET /api/cases`.
 *
 * Builds the Drizzle query for the cases listing endpoint.
 * Tenant isolation is enforced by an explicit tenant_id filter
 * (RLS is gone — the explicit filter is the ONLY tenant boundary):
 *   - IDOR: not applicable to list — users only see their tenant's rows
 *
 * AC9:  List is isolated by tenant_id.
 * AC11: Filter by claim type returns only matching cases.
 * AC12: Pagination per_page is capped at 100.
 */

import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { countRows, ilikeAny } from "@/lib/db/helpers";
import { cases, extractedFields } from "@/lib/db/schema";
import type { CaseRow } from "@/lib/db/types";
import type { CaseQuery, SortColumn } from "@/lib/schemas/cases";

export type { CaseRow };

export interface CaseListResult {
  data: CaseRow[];
  meta: {
    total: number;
    page: number;
    per_page: number;
    pages: number;
  };
}

/** Extract a loggable error code from a thrown DB error (PII-safe). */
function errCode(err: unknown): string {
  return (
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.name : "UnknownError")
  );
}

/** Whitelisted sort columns (SortColumnSchema prevents arbitrary input). */
const SORT_COLUMNS = {
  created_at: cases.created_at,
  confidence_min: cases.confidence_min,
  status: cases.status,
} as const satisfies Record<SortColumn, unknown>;

/**
 * Query cases with filtering, sorting, and pagination.
 *
 * Every query filters explicitly by the caller's tenant_id. The caller MUST
 * pass the authenticated user's tenant id — never a client-supplied value —
 * to preserve IDOR safety.
 *
 * raw_intake_text is intentionally NOT selected here (large field, not needed for list).
 */
export async function listCases(
  tenantId: string,
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

  // ── Shared filters ─────────────────────────────────────────────────────────
  const conditions: (SQL | undefined)[] = [eq(cases.tenant_id, tenantId)];

  if (status) conditions.push(eq(cases.status, status));
  if (type) conditions.push(eq(cases.claim_type, type));
  if (q) {
    // Case-insensitive substring search on policyholder_name and policy_number.
    // Parameterized via Drizzle — no raw SQL string interpolation.
    conditions.push(ilikeAny([cases.policyholder_name, cases.policy_number], q));
  }
  // AC18: Email-intake filters
  if (severity) conditions.push(eq(cases.severity, severity));
  if (customer_id) conditions.push(eq(cases.customer_id, customer_id));
  if (policy_id) conditions.push(eq(cases.policy_id, policy_id));
  if (channel) conditions.push(eq(cases.channel, channel));
  if (is_claim !== undefined) conditions.push(eq(cases.is_claim, is_claim));

  const where = and(...conditions);

  // ── Count query ────────────────────────────────────────────────────────────
  let total: number;
  try {
    total = await countRows(cases, where);
  } catch (err) {
    throw new Error(`[listCases] count error: ${errCode(err)}`);
  }

  // ── Data query ─────────────────────────────────────────────────────────────
  // Select core case columns + email-intake columns added in 0005/0006.
  const sortColumn = SORT_COLUMNS[sort];
  const from = (page - 1) * per_page;

  let data: Record<string, unknown>[];
  try {
    data = await db
      .select({
        id: cases.id,
        tenant_id: cases.tenant_id,
        policy_number: cases.policy_number,
        policyholder_name: cases.policyholder_name,
        claim_type: cases.claim_type,
        status: cases.status,
        confidence_min: cases.confidence_min,
        assigned_to: cases.assigned_to,
        channel: cases.channel,
        created_at: cases.created_at,
        updated_at: cases.updated_at,
        closed_at: cases.closed_at,
        // Email-intake columns (0005, 0006)
        severity: cases.severity,
        customer_id: cases.customer_id,
        policy_id: cases.policy_id,
        email_message_id: cases.email_message_id,
        email_thread_id: cases.email_thread_id,
        is_claim: cases.is_claim,
        not_relevant_reason: cases.not_relevant_reason,
        requires_specialist: cases.requires_specialist,
        core_external_id: cases.core_external_id,
        core_error_message: cases.core_error_message,
        core_sent_at: cases.core_sent_at,
      })
      .from(cases)
      .where(where)
      .orderBy(order === "asc" ? asc(sortColumn) : desc(sortColumn))
      // Pagination — max 100 per page (enforced in CaseQuerySchema)
      .limit(per_page)
      .offset(from);
  } catch (err) {
    throw new Error(`[listCases] data error: ${errCode(err)}`);
  }

  const rows = await hydrateCaseListIdentity(
    tenantId,
    data as unknown as CaseRow[]
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
  tenantId: string,
  rows: CaseRow[]
): Promise<CaseRow[]> {
  const caseIdsNeedingHydration = rows
    .filter((row) => !row.policyholder_name || !row.policy_number)
    .map((row) => row.id);

  if (caseIdsNeedingHydration.length === 0) return rows;

  let data: Array<{ case_id: string; field_key: string; field_value: string }>;
  try {
    data = await db
      .select({
        case_id: extractedFields.case_id,
        field_key: extractedFields.field_key,
        field_value: extractedFields.field_value,
      })
      .from(extractedFields)
      .where(
        and(
          eq(extractedFields.tenant_id, tenantId),
          inArray(extractedFields.case_id, caseIdsNeedingHydration),
          inArray(extractedFields.field_key, ["full_name", "policy_number"])
        )
      );
  } catch (err) {
    console.error("[listCases] extracted_fields hydration error:", errCode(err));
    return rows;
  }

  const fieldsByCase = new Map<string, Record<string, string>>();
  for (const field of data) {
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
 * AC13: Same explicit tenant isolation as the list endpoint.
 */
export async function listCasesForExport(
  tenantId: string,
  query: Omit<CaseQuery, "page" | "per_page" | "sort" | "order">
): Promise<CaseRow[]> {
  const { status, type, q } = query;

  const conditions: (SQL | undefined)[] = [eq(cases.tenant_id, tenantId)];
  if (status) conditions.push(eq(cases.status, status));
  if (type) conditions.push(eq(cases.claim_type, type));
  if (q) {
    conditions.push(ilikeAny([cases.policyholder_name, cases.policy_number], q));
  }

  try {
    // Max 1000 rows per export.
    const data = await db
      .select({
        id: cases.id,
        policy_number: cases.policy_number,
        policyholder_name: cases.policyholder_name,
        claim_type: cases.claim_type,
        status: cases.status,
        confidence_min: cases.confidence_min,
        assigned_to: cases.assigned_to,
        channel: cases.channel,
        created_at: cases.created_at,
      })
      .from(cases)
      .where(and(...conditions))
      .orderBy(desc(cases.created_at))
      .limit(1000);

    return data as unknown as CaseRow[];
  } catch (err) {
    throw new Error(`[listCasesForExport] error: ${errCode(err)}`);
  }
}
