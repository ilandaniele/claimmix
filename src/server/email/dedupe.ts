/**
 * Idempotency check for inbound email intake.
 *
 * Postmark may deliver the same webhook multiple times (e.g. on retry after
 * a 5xx response). This module checks whether a case already exists for the
 * given (tenant_id, email_message_id) pair before creating a new one.
 *
 * Uses the service-role client to bypass RLS — this is a system-level check
 * that runs before the user-scoped request context is fully established.
 *
 * AC3: Duplicate MessageID returns { isDuplicate: true, existingCaseId }.
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export interface DedupeResult {
  isDuplicate: boolean;
  existingCaseId?: string;
}

/**
 * Check if a case already exists for the given email MessageID and tenant.
 *
 * @param messageId - Postmark MessageID (unique per email)
 * @param tenantId  - Tenant UUID for scoping the lookup
 * @returns { isDuplicate: boolean; existingCaseId?: string }
 */
export async function dedupe(
  messageId: string,
  tenantId: string
): Promise<DedupeResult> {
  const supabase = createServiceClient();

  // Query the cases table for a matching (tenant_id, email_message_id) pair.
  // The migration adds a UNIQUE INDEX on (tenant_id, email_message_id).
  const { data, error } = await (supabase as any)
    .from("cases")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("email_message_id", messageId)
    .maybeSingle();

  if (error) {
    // Log code only — never raw Supabase error body (may contain PII).
    console.error("[dedupe] Supabase error:", error.code);
    // On DB error, fail open — let the request proceed (idempotency is best-effort).
    return { isDuplicate: false };
  }

  if (data) {
    return { isDuplicate: true, existingCaseId: (data as { id: string }).id };
  }

  return { isDuplicate: false };
}
