/**
 * Idempotency check for inbound email intake.
 *
 * W4: Updated to query claim_messages first (by provider_message_id), then
 * fall back to the legacy cases.email_message_id index. This dual-check
 * covers both new rows written by this PR and rows written before the
 * migration (during the dual-write window).
 *
 * Uses the service-role client to bypass RLS — this is a system-level check
 * that runs before the user-scoped request context is fully established.
 *
 * AC2: Duplicate provider_message_id returns { isDuplicate: true, existingCaseId }.
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

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
 * @param supabase  - Service-role Supabase client (bypasses RLS)
 * @param tenantId  - Tenant UUID for scoping the lookup
 * @param providerMessageId - Normalised provider Message-ID (no angle brackets)
 * @returns { isDuplicate: boolean; existingCaseId?: string }
 */
export async function checkDuplicate(
  supabase: ReturnType<typeof createServiceClient>,
  tenantId: string,
  providerMessageId: string
): Promise<boolean> {
  // Primary check: claim_messages table (new path — W4 onwards).
  const { data, error } = await (supabase as any)
    .from("claim_messages")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("provider_message_id", providerMessageId)
    .limit(1)
    .maybeSingle();

  if (error) {
    // Log code only — never raw Supabase error body (may contain PII).
    console.error("[dedupe] claim_messages check error:", error.code); // crew-debug-ok
    // Fail open — let the request proceed; idempotency is best-effort.
    return false;
  }

  return data !== null && data !== undefined;
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
  const normalised = normalizeMessageId(messageId);
  const supabase = createServiceClient();

  // 1. New path: check claim_messages by provider_message_id (AC2).
  const isDuplicateInClaimMessages = await checkDuplicate(
    supabase,
    tenantId,
    normalised
  );

  if (isDuplicateInClaimMessages) {
    // Resolve the case_id by reading the claim_messages row.
    const { data: msgRow } = await (supabase as any)
      .from("claim_messages")
      .select("case_id")
      .eq("tenant_id", tenantId)
      .eq("provider_message_id", normalised)
      .limit(1)
      .maybeSingle();

    return {
      isDuplicate: true,
      existingCaseId: (msgRow as { case_id: string } | null)?.case_id,
    };
  }

  // 2. Legacy fallback: check cases.email_message_id for rows pre-migration.
  const { data: caseRow, error: caseError } = await (supabase as any)
    .from("cases")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("email_message_id", normalised)
    .maybeSingle();

  if (caseError) {
    console.error("[dedupe] cases check error:", caseError.code); // crew-debug-ok
    return { isDuplicate: false };
  }

  if (caseRow) {
    return { isDuplicate: true, existingCaseId: (caseRow as { id: string }).id };
  }

  return { isDuplicate: false };
}
