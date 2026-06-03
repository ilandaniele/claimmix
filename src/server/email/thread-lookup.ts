/**
 * Thread lookup for inbound email replies.
 *
 * When a claimant replies to an existing case notification, Postmark includes
 * the original Message-ID in the In-Reply-To header. This module looks up the
 * existing case by matching:
 *
 *   1. claim_messages.provider_message_id WHERE direction='outbound'
 *      → handles the case where a claimant replies to our outbound email (IC7, AC6).
 *   2. cases.email_thread_id
 *      → legacy / inbound-thread matching (existing behaviour).
 *
 * Resolution strategy:
 *   a. Check InReplyTo (most precise — direct reply to a specific message)
 *   b. Fall back to References (space-separated chain — check each token)
 *   c. If neither matches: return { existingCaseId: undefined }
 *
 * The outbound claim_messages check is tried first because it is the common
 * case once W4/W5 are deployed: claimants reply to Postmark-sent outbound
 * messages whose provider_message_id is stored in claim_messages.
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export interface ThreadLookupResult {
  existingCaseId?: string;
}

/**
 * Attempt to find an existing case whose thread matches the In-Reply-To or
 * References headers of the incoming email.
 *
 * Extended in W4 to query claim_messages.provider_message_id (direction='outbound')
 * as a first-pass before falling back to cases.email_thread_id (legacy).
 *
 * @param tenantId    - Tenant UUID for scoping the lookup
 * @param inReplyTo   - Value of the In-Reply-To header (may include angle brackets)
 * @param references  - Value of the References header (space-separated message-ids)
 * @returns { existingCaseId?: string }
 */
export async function threadLookup(
  tenantId: string,
  inReplyTo: string,
  references: string
): Promise<ThreadLookupResult> {
  // Collect candidate thread IDs from both headers (angle brackets stripped).
  const candidates = buildCandidates(inReplyTo, references);

  if (candidates.length === 0) {
    return { existingCaseId: undefined };
  }

  const supabase = createServiceClient();

  // ── 1. New path: claim_messages WHERE direction='outbound' (AC6 / IC7) ────
  // A claimant reply to one of our Postmark outbound emails will have
  // In-Reply-To = <postmark_message_id>.  That id is stored in
  // claim_messages.provider_message_id with direction='outbound'.
  const { data: claimMsgRow, error: claimMsgError } = await (supabase as any)
    .from("claim_messages")
    .select("case_id")
    .eq("tenant_id", tenantId)
    .eq("direction", "outbound")
    .in("provider_message_id", candidates)
    .limit(1)
    .maybeSingle();

  if (claimMsgError) {
    console.error("[thread-lookup] claim_messages error:", claimMsgError.code);
    // Non-fatal — fall through to legacy check.
  } else if (claimMsgRow) {
    return {
      existingCaseId: (claimMsgRow as { case_id: string }).case_id,
    };
  }

  // ── 2. Legacy path: cases.email_thread_id ────────────────────────────────
  // This covers:
  //   - Replies to the original inbound message (cases.email_thread_id = first MessageID)
  //   - Any rows that predate the claim_messages table (migration 0009)
  const { data: caseRow, error: caseError } = await (supabase as any)
    .from("cases")
    .select("id, email_thread_id")
    .eq("tenant_id", tenantId)
    .in("email_thread_id", candidates)
    .maybeSingle();

  if (caseError) {
    console.error("[thread-lookup] cases error:", caseError.code);
    return { existingCaseId: undefined };
  }

  if (caseRow) {
    return { existingCaseId: (caseRow as { id: string }).id };
  }

  return { existingCaseId: undefined };
}

/**
 * Build a deduplicated list of candidate thread IDs from In-Reply-To and References.
 * Normalizes angle brackets (e.g. "<abc@mail>" → "abc@mail") and filters empty strings.
 */
function buildCandidates(inReplyTo: string, references: string): string[] {
  const normalize = (s: string): string =>
    s.trim().replace(/^<+/, "").replace(/>+$/, "").trim();

  const seen = new Set<string>();
  const candidates: string[] = [];

  const addCandidate = (raw: string) => {
    const normalized = normalize(raw);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      candidates.push(normalized);
    }
  };

  // In-Reply-To first (most precise).
  if (inReplyTo) {
    addCandidate(inReplyTo);
  }

  // References: space-separated list of message-IDs.
  if (references) {
    for (const ref of references.trim().split(/\s+/)) {
      addCandidate(ref);
    }
  }

  return candidates;
}
