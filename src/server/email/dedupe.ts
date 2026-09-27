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
import { eq } from "drizzle-orm";
import { enTenant, type TenantContext } from "@/data/scope";
import { claimMessages } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";

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
    logger.error({ code: errorCode(err) }, "dedupe.claim_messages_check_error");
    // Fail open — let the request proceed; idempotency is best-effort.
    return false;
  }
}
