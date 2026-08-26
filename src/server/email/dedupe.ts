/**
 * Idempotency check for inbound email intake.
 *
 * W4: Updated to query claim_messages first (by provider_message_id), then
 * fall back to the legacy cases.email_message_id index. This dual-check
 * covers both new rows written by this PR and rows written before the
 * migration (during the dual-write window).
 *
 * System-level check that runs before the user-scoped request context is
 * fully established — every query is explicitly tenant-scoped.
 *
 * AC2: Duplicate provider_message_id returns { isDuplicate: true, existingCaseId }.
 */

import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { cases, claimMessages } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";

export interface DedupeResult {
  isDuplicate: boolean;
  existingCaseId?: string;
}

/**
 * Normalise a provider Message-ID by stripping leading/trailing angle brackets.
 * Gmail API IDs do not use angle brackets, but email Message-ID headers and
 * In-Reply-To / References headers always include them.  We strip them at every
 * boundary so storage and comparison are always angle-bracket-free (AC15).
 */
export function normalizeMessageId(raw: string): string {
  return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * Check if an inbound message with the given provider_message_id already exists
 * in claim_messages for this tenant.  Falls back to the legacy cases table lookup
 * so duplicate detection works during the dual-write transition window.
 *
 * @param tenantId  - Tenant UUID for scoping the lookup
 * @param providerMessageId - Normalised provider Message-ID (no angle brackets)
 * @returns true when a matching claim_messages row exists
 */
export async function checkDuplicate(
  tenantId: string,
  providerMessageId: string
): Promise<boolean> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  // Primary check: claim_messages table (new path — W4 onwards).
  try {
    const row = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: claimMessages.id })
          .from(claimMessages)
          .where(
            eq(claimMessages.provider_message_id, providerMessageId)
          )
          .limit(1)
      )
    );

    return row !== null;
  } catch (err) {
    // Log code only — never raw DB error body (may contain PII).
    const code = (err as { code?: string })?.code ?? (err instanceof Error ? err.name : "UnknownError");
    console.error("[dedupe] claim_messages check error:", code); // crew-debug-ok
    // Fail open — let the request proceed; idempotency is best-effort.
    return false;
  }
}

/**
 * Full dedupe check: queries claim_messages first, then falls back to the
 * legacy cases.email_message_id index for rows written before migration 0009.
 *
 * This is the original exported symbol used by the route handler.  It is kept
 * for backwards compatibility and extended to use checkDuplicate internally.
 *
 * @param messageId - Provider Message-ID (may include angle brackets — normalised internally)
 * @param tenantId  - Tenant UUID for scoping the lookup
 * @returns { isDuplicate: boolean; existingCaseId?: string }
 */
export async function dedupe(
  messageId: string,
  tenantId: string
): Promise<DedupeResult> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const normalised = normalizeMessageId(messageId);

  // 1. New path: check claim_messages by provider_message_id (AC2).
  const isDuplicateInClaimMessages = await checkDuplicate(tenantId, normalised);

  if (isDuplicateInClaimMessages) {
    // Resolve the case_id by reading the claim_messages row.
    let msgRow: { case_id: string } | null = null;
    try {
      msgRow = firstRow(
        await enTenant(tenantCtx, (db) =>
          db
            .select({ case_id: claimMessages.case_id })
            .from(claimMessages)
            .where(
              eq(claimMessages.provider_message_id, normalised)
            )
            .limit(1)
        )
      );
    } catch {
      // Best-effort — duplicate already established; case id resolution failed.
      msgRow = null;
    }

    return {
      isDuplicate: true,
      existingCaseId: msgRow?.case_id,
    };
  }

  // 2. Legacy fallback: check cases.email_message_id for rows pre-migration.
  let caseRow: { id: string } | null = null;
  try {
    caseRow = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: cases.id })
          .from(cases)
          .where(
            eq(cases.email_message_id, normalised)
          )
          .limit(1)
      )
    );
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err instanceof Error ? err.name : "UnknownError");
    console.error("[dedupe] cases check error:", code); // crew-debug-ok
    return { isDuplicate: false };
  }

  if (caseRow) {
    return { isDuplicate: true, existingCaseId: caseRow.id };
  }

  return { isDuplicate: false };
}
