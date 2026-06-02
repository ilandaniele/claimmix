/**
 * Thread lookup for inbound email replies.
 *
 * When a claimant replies to an existing case notification, Postmark includes
 * the original Message-ID in the In-Reply-To header. This module looks up the
 * existing case by matching the raw_messages table on email_thread_id stored
 * in the cases table.
 *
 * Resolution strategy (IC10):
 *   1. Check InReplyTo (most precise — direct reply to a specific message)
 *   2. Fall back to References (space-separated chain — check each token)
 *   3. If neither matches: return { existingCaseId: undefined }
 *
 * AC4: If a matching thread is found, the route handler appends a new
 * raw_messages row to the existing case instead of creating a new case.
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export interface ThreadLookupResult {
  existingCaseId?: string;
}

/**
 * Attempt to find an existing case whose email_thread_id matches the
 * In-Reply-To or References headers of the incoming email.
 *
 * @param tenantId    - Tenant UUID for scoping the lookup
 * @param inReplyTo   - Value of the In-Reply-To header (normalized message-id)
 * @param references  - Value of the References header (space-separated message-ids)
 * @returns { existingCaseId?: string }
 */
export async function threadLookup(
  tenantId: string,
  inReplyTo: string,
  references: string
): Promise<ThreadLookupResult> {
  // Collect candidate thread IDs from both headers.
  const candidates = buildCandidates(inReplyTo, references);

  if (candidates.length === 0) {
    return { existingCaseId: undefined };
  }

  const supabase = createServiceClient();

  // Query cases table for any row where email_thread_id matches one of the
  // candidates. The UNIQUE INDEX on (tenant_id, email_thread_id) makes this fast.
  const { data, error } = await (supabase as any)
    .from("cases")
    .select("id, email_thread_id")
    .eq("tenant_id", tenantId)
    .in("email_thread_id", candidates)
    .maybeSingle();

  if (error) {
    console.error("[thread-lookup] Supabase error:", error.code);
    return { existingCaseId: undefined };
  }

  if (data) {
    return { existingCaseId: (data as { id: string }).id };
  }

  return { existingCaseId: undefined };
}

/**
 * Build a deduplicated list of candidate thread IDs from In-Reply-To and References.
 * Normalizes angle brackets (e.g. "<abc@mail>" → "abc@mail") and filters empty strings.
 */
function buildCandidates(inReplyTo: string, references: string): string[] {
  const normalize = (s: string): string =>
    s.trim().replace(/^</, "").replace(/>$/, "").trim();

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
