/**
 * Attachment rehost service — uploads inbound email attachments to object
 * storage with content-hash deduplication.
 *
 * Called synchronously within the inbound email pipeline, bounded by a
 * configurable aggregate budget (default 5 000 ms per IC6).
 *
 * Failures are recorded as { stored: false, reason } and do NOT abort the
 * webhook — the case + claim_messages rows are already committed by the time
 * rehostAttachments() is called.
 *
 * AC7:  Valid attachment → storage upload + content_hash persisted.
 * AC8:  Disallowed content-type → stored: false, reason='content_type_not_allowed'.
 * AC9:  Oversize → stored: false, reason='size_exceeded'.
 * AC10: Same content_hash within a case → reuse existing storage_path, no new upload.
 * AC11: Budget exhausted → remaining attachments get reason='rehost_timeout'.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimAttachments } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";
import { computeContentHash, uploadAttachment } from "@/server/storage/claim-attachments-bucket";
import { validateAttachment, MAX_AGGREGATE_SIZE_BYTES } from "@/server/email/attachment-validator";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Normalized inbound email attachment.
 * Content is base64-encoded bytes (inline payload, not a CDN URL download).
 */
export interface EmailAttachment {
  Name: string;
  /** Base64-encoded attachment bytes (may be empty string if only ContentURL is set). */
  Content: string;
  ContentType: string;
  /** Byte length of the decoded content. */
  ContentLength: number;
}

export type RehostResult =
  | { stored: true; storagePath: string; contentHash: string }
  | { stored: false; reason: string };

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Reject after `ms` milliseconds — used in Promise.race for budget enforcement. */
function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("rehost_timeout")), ms)
  );
}

/**
 * Look up an existing claim_attachments row by (case_id, content_hash).
 *
 * Returns the existing storage_path if found, null otherwise.
 *
 * AC10: Deduplication — if the same file was attached before, reuse the path.
 */
async function findExistingByHash(
  tenantId: string,
  caseId: string,
  contentHash: string
): Promise<string | null> {
  try {
    const row = firstRow(
      await db
        .select({ storage_path: claimAttachments.storage_path })
        .from(claimAttachments)
        .where(
          and(
            eq(claimAttachments.tenant_id, tenantId),
            eq(claimAttachments.case_id, caseId),
            eq(claimAttachments.content_hash, contentHash)
          )
        )
        .limit(1)
    );

    return row?.storage_path ?? null;
  } catch {
    // Best-effort dedupe — on lookup failure, fall through to a fresh upload.
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface RehostAttachmentsOpts {
  attachments: EmailAttachment[];
  tenantId: string;
  caseId: string;
  /** The newly-inserted claim_messages.id — used as the path segment. */
  messageId: string;
  /** Aggregate time budget in milliseconds. Default: 5 000. */
  budgetMs?: number;
}

/**
 * Rehost each attachment from an inline base64 payload to object storage.
 *
 * Returns one RehostResult per attachment, in the same order as the input array.
 *
 * Budget enforcement (AC11):
 *   - A single deadline is set at `Date.now() + budgetMs`.
 *   - Before each attachment, remaining budget is checked; if ≤ 0, the attachment
 *     is immediately marked { stored: false, reason: 'rehost_timeout' }.
 *   - For the upload step, Promise.race([upload, timeout(remaining)]) caps the
 *     individual upload within the global remaining budget.
 */
export async function rehostAttachments(
  opts: RehostAttachmentsOpts
): Promise<RehostResult[]> {
  const {
    attachments,
    tenantId,
    caseId,
    messageId,
    budgetMs = 5_000,
  } = opts;

  const deadline = Date.now() + budgetMs;
  const results: RehostResult[] = [];
  let runningBytes = 0;

  for (const attachment of attachments) {
    const remaining = deadline - Date.now();

    // AC11: budget exhausted — mark remaining attachments without attempting upload.
    if (remaining <= 0) {
      results.push({ stored: false, reason: "rehost_timeout" });
      continue;
    }

    // ── Decode base64 content ──────────────────────────────────────────────────
    let data: Buffer;
    try {
      data = Buffer.from(attachment.Content, "base64");
    } catch {
      results.push({ stored: false, reason: "decode_failed" });
      continue;
    }

    // ── Aggregate size cap (25 MB across all attachments in one email) ─────────
    // Checked AFTER decoding so we know the real byte count, but BEFORE the
    // per-attachment size check — the running total may cross 25 MB even when
    // each individual file is under the 10 MB per-attachment cap.
    runningBytes += data.length;
    if (runningBytes > MAX_AGGREGATE_SIZE_BYTES) {
      results.push({ stored: false, reason: "aggregate_size_exceeded" });
      continue;
    }

    // ── Compute content hash ───────────────────────────────────────────────────
    const contentHash = computeContentHash(data);

    // ── AC10: dedupe by content_hash within the case ───────────────────────────
    const existingPath = await findExistingByHash(tenantId, caseId, contentHash);
    if (existingPath !== null) {
      // File already uploaded for this case — reuse the existing storage path.
      results.push({ stored: true, storagePath: existingPath, contentHash });
      continue;
    }

    // ── Validate content-type and size ─────────────────────────────────────────
    const validation = validateAttachment(attachment.ContentType, data.length);
    if (!validation.ok) {
      results.push({ stored: false, reason: validation.reason });
      continue;
    }

    // ── Upload to object storage within remaining budget ───────────────────────
    const remainingAfterDedupe = deadline - Date.now();
    if (remainingAfterDedupe <= 0) {
      results.push({ stored: false, reason: "rehost_timeout" });
      continue;
    }

    let uploadResult: { storagePath: string } | { error: string };
    try {
      uploadResult = await Promise.race([
        uploadAttachment({
          tenantId,
          caseId,
          messageId,
          filename: attachment.Name,
          contentType: attachment.ContentType,
          data,
        }),
        timeoutPromise(remainingAfterDedupe),
      ]);
    } catch {
      // Promise.race rejected — timeout fired.
      results.push({ stored: false, reason: "rehost_timeout" });
      continue;
    }

    if ("error" in uploadResult) {
      results.push({ stored: false, reason: "storage_upload_failed" });
      continue;
    }

    results.push({
      stored: true,
      storagePath: uploadResult.storagePath,
      contentHash,
    });
  }

  return results;
}
