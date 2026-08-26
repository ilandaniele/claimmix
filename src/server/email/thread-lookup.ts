/**
 * Thread lookup for inbound email replies.
 *
 * When a claimant replies to an existing case notification, the provider includes
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
 * case once W4/W5 are deployed: claimants reply to provider-sent outbound
 * messages whose provider_message_id is stored in claim_messages.
 */

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { cases, claimMessages } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";

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
  references: string,
  subject: string = ""
): Promise<ThreadLookupResult> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  // Collect candidate thread IDs from both headers (angle brackets stripped).
  const candidates = buildCandidates(inReplyTo, references);

  // ── 1. New path: claim_messages WHERE direction='outbound' (AC6 / IC7) ────
  // A claimant reply to one of our outbound emails will have
  // In-Reply-To = <provider_message_id>.  That id is stored in
  // claim_messages.provider_message_id with direction='outbound'.
  try {
    const claimMsgRow = candidates.length === 0 ? null : firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ case_id: claimMessages.case_id })
          .from(claimMessages)
          .where(
            and(
              eq(claimMessages.direction, "outbound"),
              inArray(claimMessages.provider_message_id, candidates)
            )
          )
          .limit(1)
      )
    );

    if (claimMsgRow) {
      return { existingCaseId: claimMsgRow.case_id };
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err instanceof Error ? err.name : "UnknownError");
    console.error("[thread-lookup] claim_messages error:", code); // crew-debug-ok
    // Non-fatal — fall through to legacy check.
  }

  // ── 2. Legacy path: cases.email_thread_id ────────────────────────────────
  // This covers:
  //   - Replies to the original inbound message (cases.email_thread_id = first MessageID)
  //   - Any rows that predate the claim_messages table (migration 0009)
  try {
    const caseRow = candidates.length === 0 ? null : firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: cases.id, email_thread_id: cases.email_thread_id })
          .from(cases)
          .where(
            and(
              inArray(cases.email_thread_id, candidates)
            )
          )
          .limit(1)
      )
    );

    if (caseRow) {
      return { existingCaseId: caseRow.id };
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err instanceof Error ? err.name : "UnknownError");
    console.error("[thread-lookup] cases error:", code); // crew-debug-ok
    return { existingCaseId: undefined };
  }

  // ── 3. Last resort: the case number we put in our own subject ────────────
  // Some clients drop References on reply, and a claimant may forward the mail
  // or start a fresh one quoting it. Every outbound subject already carries
  // "Caso #<uuid>", so the correlation survives even when the headers do not.
  // Checked last: a matching header is a fact, a subject is a string someone
  // may have typed.
  const subjectCaseId = caseIdFromSubject(subject);
  if (subjectCaseId) {
    try {
      const caseRow = firstRow(
        await enTenant(tenantCtx, (db) =>
          db
            .select({ id: cases.id })
            .from(cases)
            .where(eq(cases.id, subjectCaseId))
            .limit(1)
        )
      );
      if (caseRow) return { existingCaseId: caseRow.id };
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "DBError";
      console.error("[thread-lookup] subject case lookup error:", code); // crew-debug-ok
    }
  }

  return { existingCaseId: undefined };
}

/** `"Re: Recibimos tu reclamo - Caso #<uuid>"` → the uuid, if there is one. */
export function caseIdFromSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const match = subject.match(
    /caso\s*#\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return match ? match[1].toLowerCase() : null;
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
