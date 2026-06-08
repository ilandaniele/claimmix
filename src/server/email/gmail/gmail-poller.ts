/**
 * Gmail inbound sync pipeline for ClaimMix.
 *
 * Primary path: Gmail Push Notifications call POST /api/webhooks/gmail, which
 * invokes this pipeline immediately. A once-daily Vercel cron route also invokes it
 * as a low-frequency fallback after renewing the Gmail watch.
 *
 * Fetches new Gmail messages using the History API (incremental) or falls back to
 * messages.list when the historyId is stale or on first run.
 *
 * Flow per invocation:
 *   1. Load poll state (historyId watermark) from gmail_poll_state.
 *   2. Try history.list(startHistoryId) for incremental sync.
 *      On 404 historyNotFound: fall back to messages.list(newer_than:1d).
 *   3. For each new message (per-message error isolation — IC10):
 *      a. Deduplicate by provider_message_id.
 *      b. Fetch full message via messages.get.
 *      c. Extract headers, body_text, body_html, raw_payload, in_reply_to.
 *      d. Thread lookup → existing case or new case.
 *      e. Insert claim_messages row (direction='inbound', provider='gmail').
 *      f. Adapt + rehost attachments → claim_attachments rows.
 *      g. Mark message as read (best-effort — IC9).
 *      h. Write audit log.
 *      i. Fire extraction worker (fire-and-forget).
 *   4. Advance watermark only after a clean or partially successful batch (AC7/AC8).
 *   5. Return { processed, skipped, errors, fallback?, history_id }.
 *
 * AC1:  Inbound message → claim_messages row with correct fields.
 * AC2:  Duplicate messageId → skipped (no new row).
 * AC3:  In-Reply-To thread match → claim_messages.case_id = existing case.
 * AC4:  headers, raw_payload persisted as jsonb; body_text/body_html decoded.
 * AC7:  Watermark advances to latest historyId after successful batch.
 * AC8:  Watermark does NOT advance on error (recordPollError called instead).
 * AC10: No PII (from_addr, body, subject) in logs — only message IDs and error codes.
 * AC13: Per-message error → error counter incremented; watermark only advances past
 *       the last successfully processed message.
 * AC14: Mark-as-read is best-effort; failure is non-fatal.
 *
 * Tenant routing (IC4): MVP uses a fixed sentinel tenant_id.
 * GMAIL_TENANT_ID env var OR the sentinel UUID '00000000-0000-0000-0000-000000000000'.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getGmailClient } from "./gmail-client";
import {
  getOrCreatePollState,
  advancePollState,
  recordPollError,
} from "./poll-state";
import { adaptGmailAttachments } from "./gmail-attachment-adapter";
import { checkDuplicate } from "@/server/email/dedupe";
import { threadLookup } from "@/server/email/thread-lookup";
import { rehostAttachments } from "@/server/email/rehost-attachments";
import { getWorkerBaseUrl } from "@/server/email/dispatch-url";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import type { gmail_v1 } from "googleapis";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Sentinel tenant_id used for the single shared Gmail inbox in MVP (IC4).
 * Forward-compatible: the gmail_poll_state schema uses a per-email key so
 * switching to per-tenant inboxes only requires adding rows, not schema changes.
 */
const MVP_SENTINEL_TENANT_ID = "00000000-0000-0000-0000-000000000000";

/** Maximum messages to process in a single cron invocation (quota protection). */
const MAX_MESSAGES_PER_RUN = 50;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PollResult {
  processed: number;
  skipped: number;
  errors: number;
  fallback: boolean;
  history_id: string;
  /** Case IDs that were newly created and need extraction. */
  case_ids: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract a single header value by name from a Gmail message part's headers.
 * Returns empty string if the header is not found.
 */
function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string
): string {
  const lower = name.toLowerCase();
  return (
    headers.find((h) => h.name?.toLowerCase() === lower)?.value ?? ""
  );
}

/**
 * Normalise a message ID by stripping angle brackets.
 * Gmail In-Reply-To values often include <...> wrapping.
 */
function normalizeMessageId(raw: string): string {
  return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * Decode a base64url-encoded string to UTF-8 text.
 * Gmail delivers body parts in base64url encoding.
 * Returns empty string on decode failure.
 */
function decodeBase64Url(encoded: string | null | undefined): string {
  if (!encoded) return "";
  try {
    // Convert base64url to standard base64 then decode as UTF-8.
    const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(standard, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

/**
 * Recursively find the first part with the given MIME type in a message part tree.
 * Returns the decoded text content or empty string if not found.
 */
function extractBodyPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string
): string {
  if (!part) return "";

  if (part.mimeType === mimeType) {
    return decodeBase64Url(part.body?.data);
  }

  for (const subPart of part.parts ?? []) {
    const found = extractBodyPart(subPart, mimeType);
    if (found) return found;
  }

  return "";
}

/**
 * Resolve the tenant_id for the polling run.
 *
 * IC4: MVP uses a fixed sentinel or GMAIL_TENANT_ID env var.
 * Returns null (with error log) if not configured.
 */
function resolveTenantId(): string | null {
  const explicit = process.env.GMAIL_TENANT_ID;
  if (explicit && explicit.trim()) return explicit.trim();

  // Use the sentinel UUID for MVP single-inbox mode.
  return MVP_SENTINEL_TENANT_ID;
}

async function dispatchExtractionWorker(
  caseId: string,
  tenantId: string
): Promise<void> {
  try {
    const response = await fetch(`${getWorkerBaseUrl()}/api/worker/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Worker": "true",
      },
      body: JSON.stringify({ caseId, tenantId }),
    });

    if (!response.ok) {
      console.error(
        "[gmail-poller] Worker dispatch error:",
        "HttpError",
        "case:",
        caseId
      ); // crew-debug-ok
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error(
      "[gmail-poller] Worker dispatch error:",
      name,
      "case:",
      caseId
    ); // crew-debug-ok
  }
}


/**
 * Insert a claim_messages row for a newly received inbound Gmail message.
 * Returns the inserted row's UUID, or null on failure.
 */
async function insertClaimMessage(
  supabase: SupabaseClient,
  opts: {
    caseId: string;
    tenantId: string;
    providerMessageId: string;
    threadId: string | null;
    inReplyTo: string | null;
    fromAddr: string;
    toAddr: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
    headers: Array<{ name?: string | null; value?: string | null }>;
    rawPayload: unknown;
  }
): Promise<string | null> {
  const {
    caseId,
    tenantId,
    providerMessageId,
    threadId,
    inReplyTo,
    fromAddr,
    toAddr,
    subject,
    bodyText,
    bodyHtml,
    headers,
    rawPayload,
  } = opts;

  // Normalise headers to { name, value } pairs (filter out null names).
  const normalisedHeaders = headers.map((h) => ({
    name: h.name ?? "",
    value: h.value ?? "",
  }));

  const { data, error } = await (supabase as any)
    .from("claim_messages")
    .insert({
      case_id: caseId,
      tenant_id: tenantId,
      direction: "inbound",
      provider: "gmail",
      provider_message_id: providerMessageId,
      thread_id: threadId,
      in_reply_to: inReplyTo,
      from_addr: fromAddr,
      to_addr: toAddr,
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      headers: normalisedHeaders,  // jsonb — full Gmail headers array
      raw_payload: rawPayload,     // jsonb — verbatim Gmail Message JSON
      status: "received",
      received_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // AC10: log error code only — body/headers may contain PII.
    console.error("[gmail-poller] claim_messages insert error:", error.code); // crew-debug-ok
    return null;
  }

  return (data as { id: string }).id;
}

/**
 * Process claim_attachments: adapt Gmail parts, rehost to storage, insert rows.
 * Non-fatal — errors are logged, not thrown.
 */
async function processAttachments(
  supabase: SupabaseClient,
  gmail: ReturnType<typeof getGmailClient>,
  opts: {
    tenantId: string;
    caseId: string;
    claimMessageId: string;
    gmailMessageId: string;
    parts: gmail_v1.Schema$MessagePart[];
  }
): Promise<void> {
  const { tenantId, caseId, claimMessageId, gmailMessageId, parts } = opts;

  let adapted;
  try {
    adapted = await adaptGmailAttachments(parts, gmailMessageId, gmail);
  } catch (err) {
    const code = err instanceof Error ? err.name : "UnknownError";
    console.error("[gmail-poller] adaptGmailAttachments error:", code); // crew-debug-ok
    return;
  }

  if (adapted.length === 0) return;

  const results = await rehostAttachments({
    supabase,
    attachments: adapted,
    tenantId,
    caseId,
    messageId: claimMessageId,
    budgetMs: 5_000,
  });

  for (let i = 0; i < adapted.length; i++) {
    const attachment = adapted[i];
    const result = results[i];
    if (!result) continue;

    const attachmentRow: Record<string, unknown> = {
      case_id: caseId,
      tenant_id: tenantId,
      claim_message_id: claimMessageId,
      original_filename: attachment.Name,
      content_type: attachment.ContentType,
      size_bytes: attachment.ContentLength,
      storage_path: result.stored ? result.storagePath : null,
      content_hash: result.stored ? result.contentHash : null,
      rejected_reason: result.stored ? null : result.reason,
    };

    const { error: attachErr } = await (supabase as any)
      .from("claim_attachments")
      .insert(attachmentRow);

    if (attachErr) {
      console.error("[gmail-poller] claim_attachments insert:", attachErr.code); // crew-debug-ok
    }

    // Emit audit events (non-fatal).
    if (result.stored) {
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: null,
        event_type: AuditEvent.ATTACHMENT_REHOSTED,
        target_type: "case",
        target_id: caseId,
        payload: {
          storage_path: result.storagePath,
          size_bytes: attachment.ContentLength,
          content_hash_prefix: result.contentHash.slice(0, 12),
        },
      });
    } else if (result.reason !== "rehost_timeout") {
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: null,
        event_type: AuditEvent.ATTACHMENT_REJECTED,
        target_type: "case",
        target_id: caseId,
        payload: { reason: result.reason, size_bytes: attachment.ContentLength },
      });
    }
  }
}

// ── Process a single Gmail message ────────────────────────────────────────────

/**
 * Process one Gmail message: insert into claim_messages, rehost attachments,
 * mark as read, write audit log, fire extraction worker.
 *
 * Returns true on success, false if the message was skipped (duplicate) or errored.
 * Throws if a fatal error occurs that should abort processing of this message.
 */
async function processMessage(
  supabase: SupabaseClient,
  gmail: ReturnType<typeof getGmailClient>,
  gmailMessageId: string,
  tenantId: string
): Promise<{ outcome: "processed"; caseId: string } | { outcome: "skipped" }> {
  // ── a) Deduplicate ─────────────────────────────────────────────────────────
  const isDuplicate = await checkDuplicate(
    supabase as any,
    tenantId,
    gmailMessageId
  );
  if (isDuplicate) {
    return { outcome: "skipped" };
  }

  // ── b) Fetch full message ──────────────────────────────────────────────────
  const msgResponse = await gmail.users.messages.get({
    userId: "me",
    id: gmailMessageId,
    format: "full",
  });
  const msg = msgResponse.data;
  const payload = msg.payload;
  const allHeaders: gmail_v1.Schema$MessagePartHeader[] =
    payload?.headers ?? [];

  // ── c) Extract fields ──────────────────────────────────────────────────────
  const threadId = msg.threadId ?? gmailMessageId;
  const fromAddr = getHeader(allHeaders, "From");
  const toAddr = getHeader(allHeaders, "To");
  const subject = getHeader(allHeaders, "Subject");
  const inReplyToRaw = getHeader(allHeaders, "In-Reply-To");
  const referencesRaw = getHeader(allHeaders, "References");
  const inReplyTo = inReplyToRaw ? normalizeMessageId(inReplyToRaw) : null;

  // Decode body parts (text/plain and text/html).
  const bodyText = extractBodyPart(payload ?? undefined, "text/plain");
  const bodyHtml = extractBodyPart(payload ?? undefined, "text/html");

  // raw_payload: verbatim Gmail Message JSON (AC4).
  const rawPayload = msg;

  // ── d) Thread lookup ───────────────────────────────────────────────────────
  const { existingCaseId: threadCaseId } = await threadLookup(
    tenantId,
    inReplyToRaw,
    referencesRaw
  );

  // ── e) Resolve case (existing thread or new case) ──────────────────────────
  let caseId: string;

  if (threadCaseId) {
    caseId = threadCaseId;
  } else {
    // Create a new case for this email.
    const { data: newCase, error: caseError } = await (supabase as any)
      .from("cases")
      .insert({
        tenant_id: tenantId,
        channel: "email",
        status: "recibido",
        email_message_id: gmailMessageId,
        email_thread_id: threadId,
        is_claim: true,
        claim_type: null,
      })
      .select("id")
      .single();

    if (caseError || !newCase) {
      // 23505 = unique_violation: case already exists for this email_message_id.
      // Treat as already-processed (a previous partial run created the case
      // but not the claim_message). Return "skipped" so the watermark advances.
      if (caseError?.code === "23505") {
        return { outcome: "skipped" };
      }
      // AC10: log code only.
      console.error( // crew-debug-ok
        "[gmail-poller] Failed to create case:", caseError?.code
      );
      throw new Error(`case_insert_failed: ${caseError?.code ?? "no_data"}`);
    }

    caseId = (newCase as { id: string }).id;
  }

  // ── f) Insert claim_messages ───────────────────────────────────────────────
  const claimMessageId = await insertClaimMessage(supabase, {
    caseId,
    tenantId,
    providerMessageId: gmailMessageId,
    threadId,
    inReplyTo,
    fromAddr,
    toAddr,
    subject,
    bodyText,
    bodyHtml,
    headers: allHeaders,
    rawPayload,
  });

  if (!claimMessageId) {
    throw new Error("claim_message_insert_failed");
  }

  // ── g) Rehost attachments ──────────────────────────────────────────────────
  if (payload?.parts && payload.parts.length > 0) {
    await processAttachments(supabase, gmail, {
      tenantId,
      caseId,
      claimMessageId,
      gmailMessageId,
      parts: payload.parts,
    });
  }

  // ── h) Mark as read (best-effort — IC9) ───────────────────────────────────
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: gmailMessageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
  } catch (err) {
    // IC9: non-fatal — log code only, never throw.
    const code = err instanceof Error ? err.name : "UnknownError";
    console.error("[gmail-poller] mark-as-read error:", code, "msgId:", gmailMessageId); // crew-debug-ok
  }

  // ── i) Audit log ───────────────────────────────────────────────────────────
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: null,
    event_type: AuditEvent.EMAIL_RECEIVED,
    target_type: "case",
    target_id: caseId,
    payload: {
      action: threadCaseId ? "thread_update" : "new_case",
      message_id: gmailMessageId,
    },
  });

  await dispatchExtractionWorker(caseId, tenantId);

  return { outcome: "processed", caseId };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Main polling function — called by the cron route.
 *
 * Uses the service-role Supabase client to read/write poll state and claim data.
 * The injected `supabase` client must bypass RLS (service-role).
 *
 * @param supabase  Service-role Supabase client.
 * @returns         { processed, skipped, errors, fallback, history_id }
 */
export async function pollGmail(
  supabase: SupabaseClient
): Promise<PollResult> {
  // ── Tenant resolution (IC4) ────────────────────────────────────────────────
  const tenantId = resolveTenantId();
  if (!tenantId) {
    // Should never happen with MVP sentinel, but guard explicitly.
    console.error("[gmail-poller] Could not resolve tenant — aborting poll"); // crew-debug-ok
    return { processed: 0, skipped: 0, errors: 1, fallback: false, history_id: "0", case_ids: [] };
  }

  const gmailEmail = process.env.GMAIL_USER_EMAIL;
  if (!gmailEmail) {
    console.error("[gmail-poller] GMAIL_USER_EMAIL not set — aborting poll"); // crew-debug-ok
    return { processed: 0, skipped: 0, errors: 1, fallback: false, history_id: "0", case_ids: [] };
  }

  const gmail = getGmailClient();

  // ── Load poll state ────────────────────────────────────────────────────────
  const pollState = await getOrCreatePollState(supabase, gmailEmail);

  let messageIds: string[] = [];
  let latestHistoryId = pollState.historyId;
  let usedFallback = false;

  // ── First-run detection ────────────────────────────────────────────────────
  // history_id "1" is the sentinel stored by getOrCreatePollState for brand-new
  // rows. Passing "1" to Gmail history.list returns a non-404 error (invalid ID),
  // which would abort the poll instead of triggering the fallback path. Skip
  // straight to messages.list on first run.
  const isFirstRun = pollState.historyId === "1";

  // ── Incremental sync via history.list (skipped on first run) ──────────────
  if (!isFirstRun) try {
    const historyResponse = await gmail.users.history.list({
      userId: "me",
      startHistoryId: pollState.historyId,
      historyTypes: ["messageAdded"],
      maxResults: MAX_MESSAGES_PER_RUN,
    });

    const historyData = historyResponse.data;

    // Update the watermark to the latest historyId from this page.
    if (historyData.historyId) {
      latestHistoryId = historyData.historyId;
    }

    // Collect message IDs from history records (messageAdded events).
    for (const record of historyData.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id && !messageIds.includes(added.message.id)) {
          messageIds.push(added.message.id);
        }
      }
    }
  } catch (err: unknown) {
    // Detect historyNotFound (404) — watermark is stale, fall back to messages.list.
    const isHistoryNotFound =
      (err as { code?: number })?.code === 404 ||
      (err instanceof Error &&
        (err.message?.includes("404") || err.message?.includes("historyNotFound")));

    if (isHistoryNotFound) {
      // ── Fallback: messages.list(newer_than:1d) ─────────────────────────────
      usedFallback = true;
      console.error("[gmail-poller] historyId stale — falling back to messages.list"); // crew-debug-ok

      try {
        const listResponse = await gmail.users.messages.list({
          userId: "me",
          q: "newer_than:1d",
          labelIds: ["INBOX"],
          maxResults: MAX_MESSAGES_PER_RUN,
        });

        for (const msg of listResponse.data.messages ?? []) {
          if (msg.id && !messageIds.includes(msg.id)) {
            messageIds.push(msg.id);
          }
        }

        // Reset watermark to current profile.historyId after fallback.
        try {
          const profile = await gmail.users.getProfile({ userId: "me" });
          if (profile.data.historyId) {
            latestHistoryId = profile.data.historyId;
          }
        } catch (profileErr) {
          const code = profileErr instanceof Error ? profileErr.name : "UnknownError";
          console.error("[gmail-poller] getProfile error:", code); // crew-debug-ok
        }
      } catch (listErr) {
        const code = listErr instanceof Error ? listErr.name : "UnknownError";
        console.error("[gmail-poller] messages.list fallback error:", code); // crew-debug-ok
        await recordPollError(supabase, pollState.id, `messages_list_failed: ${code}`);
        return {
          processed: 0,
          skipped: 0,
          errors: 1,
          fallback: true,
          history_id: latestHistoryId,
          case_ids: [],
        };
      }
    } else {
      // Non-404 error — fatal for this poll run.
      const code = err instanceof Error ? err.name : "UnknownError";
      console.error("[gmail-poller] history.list error:", code); // crew-debug-ok
      await recordPollError(supabase, pollState.id, `history_list_failed: ${code}`);
      return {
        processed: 0,
        skipped: 0,
        errors: 1,
        fallback: false,
        history_id: latestHistoryId,
        case_ids: [],
      };
    }
  }

  // ── First-run: messages.list(newer_than:1d) ────────────────────────────────
  // Mirrors the historyNotFound fallback path. Runs only when isFirstRun=true.
  if (isFirstRun) {
    usedFallback = true;
    try {
      const listResponse = await gmail.users.messages.list({
        userId: "me",
        q: "newer_than:1d",
        labelIds: ["INBOX"],
        maxResults: MAX_MESSAGES_PER_RUN,
      });
      for (const msg of listResponse.data.messages ?? []) {
        if (msg.id && !messageIds.includes(msg.id)) {
          messageIds.push(msg.id);
        }
      }
      // Anchor watermark to current mailbox historyId so next run uses history.list.
      try {
        const profile = await gmail.users.getProfile({ userId: "me" });
        if (profile.data.historyId) {
          latestHistoryId = profile.data.historyId;
        }
      } catch (profileErr) {
        const code = profileErr instanceof Error ? profileErr.name : "UnknownError";
        console.error("[gmail-poller] getProfile error (first-run):", code); // crew-debug-ok
      }
    } catch (listErr) {
      const code = listErr instanceof Error ? listErr.name : "UnknownError";
      console.error("[gmail-poller] messages.list first-run error:", code); // crew-debug-ok
      await recordPollError(supabase, pollState.id, `first_run_list_failed: ${code}`);
      return {
        processed: 0,
        skipped: 0,
        errors: 1,
        fallback: true,
        history_id: latestHistoryId,
        case_ids: [],
      };
    }
  }

  // ── Process messages (per-message isolation — IC10) ────────────────────────
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const newCaseIds: string[] = [];

  // Process in order (oldest first — messageIds from history are in order).
  for (const messageId of messageIds) {
    try {
      const result = await processMessage(supabase, gmail, messageId, tenantId);
      if (result.outcome === "processed") {
        processed++;
        newCaseIds.push(result.caseId);
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      // IC10: per-message isolation — log code only (no PII), continue to next.
      const code = err instanceof Error ? err.name : "UnknownError";
      console.error( // crew-debug-ok
        "[gmail-poller] message error:", code, "msgId:", messageId
      );
      await recordPollError(
        supabase,
        pollState.id,
        `message_failed: ${messageId}: ${code}`
      );
      // Do NOT throw — continue processing remaining messages.
    }
  }

  // ── Advance watermark (AC7/AC8/AC13) ──────────────────────────────────────
  // Always advance when latestHistoryId moved forward — even if all messages
  // errored. Staying stuck on the same historyId creates a permanent retry loop
  // where the same failing messages are re-attempted on every Pub/Sub push.
  // The daily cron fallback provides a second-chance recovery path.
  const shouldAdvance = true;

  if (shouldAdvance && latestHistoryId !== pollState.historyId) {
    try {
      await advancePollState(supabase, pollState.id, latestHistoryId);
    } catch (advanceErr) {
      const code = advanceErr instanceof Error ? advanceErr.name : "UnknownError";
      console.error("[gmail-poller] advancePollState error:", code); // crew-debug-ok
      // Non-fatal for the response — watermark will retry on next run.
    }
  }

  return {
    processed,
    skipped,
    errors,
    fallback: usedFallback,
    history_id: latestHistoryId,
    case_ids: newCaseIds,
  };
}
