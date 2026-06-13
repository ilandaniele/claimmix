/**
 * Outbound email dispatch service for ClaimMix.
 *
 * Coordinates the full outbound email pipeline:
 *   1. Render the template
 *   2. INSERT a claim_messages row (direction='outbound', status='queued') — AC4/AC5
 *   3. INSERT an outbound_messages row (status='queued') — dual-write window kept per IC1
 *   4. Call EmailProvider.send() — provider-agnostic (IC8, AC12)
 *   5. UPDATE claim_messages with provider_message_id + status='sent'|'failed'
 *   6. UPDATE outbound_messages with status='sent'|'failed'
 *   7. Write audit log
 *
 * DB writes run as a system actor (no user context) — every row is explicitly
 * tenant-scoped. Import from here — do not call the provider or renderTemplate
 * directly from routes.
 *
 * AC4:  claim_messages row updated with provider_message_id='out-*' after send.
 * AC5:  Function never throws — resolves with { error } on failure.
 * AC12: Confirmation receipt always sent for valid claims.
 * AC12: No direct provider imports — only getEmailProvider() from gmail/index.ts (W1).
 * AC16: In-Reply-To and References headers forwarded when inReplyToMessageId is set.
 */

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimMessages, outboundMessages } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";
import { renderTemplate, type EmailTemplate } from "./render";
import { getEmailProvider } from "./gmail/index";
import { isSendSuccess } from "./provider";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

export interface DispatchOptions {
  caseId: string;
  tenantId: string;
  to: string;
  template: EmailTemplate;
  data: Record<string, unknown>;
  /** Original provider Message-ID — used to thread the reply in the claimant's inbox. */
  inReplyToMessageId?: string;
  /** Thread ID for the case — stored in claim_messages.thread_id. */
  threadId?: string;
}

export interface DispatchResult {
  providerMessageId?: string;
  error?: string;
}

/**
 * Dispatch an outbound email for a case.
 *
 * Does NOT throw — any error is caught and logged so intake flow is not disrupted.
 *
 * Returns { providerMessageId } on success, { error } on failure.
 *
 * @param options - Dispatch options (caseId, tenantId, to, template, data, inReplyToMessageId)
 */
export async function dispatchOutboundEmail(options: DispatchOptions): Promise<DispatchResult> {
  const { caseId, tenantId, to, template, data, inReplyToMessageId, threadId } = options;

  // ── 1. Render template ─────────────────────────────────────────────────────
  let rendered: { subject: string; html: string; text: string };
  try {
    rendered = renderTemplate(template, data);
  } catch (err) {
    const name = err instanceof Error ? err.name : "RenderError";
    console.error("[dispatch] Template render error:", name); // crew-debug-ok
    return { error: "RENDER_FAILED" };
  }

  const fromAddress = process.env.GMAIL_FROM_ADDRESS ?? "";

  // ── 2. INSERT claim_messages row (status='queued') — AC4/AC5 ──────────────
  let claimMessageId: string | undefined;
  try {
    const inserted = firstRow(
      await db
        .insert(claimMessages)
        .values({
          tenant_id: tenantId,
          case_id: caseId,
          direction: "outbound",
          provider: "gmail",
          provider_message_id: null, // set after send
          thread_id: threadId ?? null,
          in_reply_to: inReplyToMessageId ?? null,
          from_addr: fromAddress,
          to_addr: to,
          subject: rendered.subject,
          body_text: rendered.text,
          template,
          status: "queued",
          headers: [],
          received_at: new Date().toISOString(),
        })
        .returning({ id: claimMessages.id })
    );

    if (inserted) {
      claimMessageId = inserted.id;
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err instanceof Error ? err.name : "DBError");
    console.error("[dispatch] Failed to insert claim_messages:", code); // crew-debug-ok
  }

  // ── 3. INSERT outbound_messages row (status='queued') — dual-write window ─
  let outboundMsgId: string | undefined;
  try {
    const inserted = firstRow(
      await db
        .insert(outboundMessages)
        .values({
          case_id: caseId,
          tenant_id: tenantId,
          channel: "email",
          template,
          rendered_body: rendered.html,
          status: "queued",
        })
        .returning({ id: outboundMessages.id })
    );

    if (inserted) {
      outboundMsgId = inserted.id;
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err instanceof Error ? err.name : "DBError");
    console.error("[dispatch] Failed to insert outbound_messages:", code); // crew-debug-ok
  }

  // ── 4. Send via EmailProvider (Gmail) ─────────────────────────────────────
  // AC16: Build In-Reply-To / References headers when threading.
  const threadingHeaders: Array<{ Name: string; Value: string }> = [];
  if (inReplyToMessageId) {
    threadingHeaders.push({ Name: "In-Reply-To", Value: inReplyToMessageId });
    threadingHeaders.push({ Name: "References", Value: inReplyToMessageId });
  }

  const provider = getEmailProvider();

  const sendResult = await provider.send({
    to,
    from: fromAddress,
    subject: rendered.subject,
    htmlBody: rendered.html,
    textBody: rendered.text,
    headers: threadingHeaders.length > 0 ? threadingHeaders : undefined,
    threadId: threadId ?? undefined,
  });

  // ── 5. Update claim_messages + outbound_messages + write audit log ─────────
  if (isSendSuccess(sendResult)) {
    const { providerMessageId } = sendResult;

    // Update claim_messages — set provider_message_id + status='sent' + sent_at
    if (claimMessageId) {
      try {
        await db
          .update(claimMessages)
          .set({
            provider_message_id: providerMessageId,
            status: "sent",
            sent_at: new Date().toISOString(),
          })
          .where(eq(claimMessages.id, claimMessageId));
      } catch (err) {
        const name = err instanceof Error ? err.name : "DBError";
        console.error("[dispatch] Failed to update claim_messages status (sent):", name); // crew-debug-ok
      }
    }

    // Update outbound_messages (dual-write window)
    if (outboundMsgId) {
      try {
        await db
          .update(outboundMessages)
          .set({ status: "sent" })
          .where(eq(outboundMessages.id, outboundMsgId));
      } catch (err) {
        const name = err instanceof Error ? err.name : "DBError";
        console.error("[dispatch] Failed to update outbound_messages status (sent):", name); // crew-debug-ok
      }
    }

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.OUTBOUND_EMAIL_SENT,
      target_type: "case",
      target_id: caseId,
      payload: {
        subject_prefix: rendered.subject.slice(0, 40), // partial subject — no PII
        provider_message_id: providerMessageId,
      },
    });

    return { providerMessageId };
  } else {
    // Provider returned an error — AC5: must not throw.
    const { errorCode } = sendResult;
    console.error("[dispatch] Email send failed, error code:", errorCode); // crew-debug-ok

    // Update claim_messages — set status='failed' + error_code
    if (claimMessageId) {
      try {
        await db
          .update(claimMessages)
          .set({ status: "failed", error_code: errorCode })
          .where(eq(claimMessages.id, claimMessageId));
      } catch (err) {
        const name = err instanceof Error ? err.name : "DBError";
        console.error("[dispatch] Failed to update claim_messages status (failed):", name); // crew-debug-ok
      }
    }

    // Update outbound_messages (dual-write window)
    if (outboundMsgId) {
      try {
        await db
          .update(outboundMessages)
          .set({ status: "failed" })
          .where(eq(outboundMessages.id, outboundMsgId));
      } catch (err) {
        const name = err instanceof Error ? err.name : "DBError";
        console.error("[dispatch] Failed to update outbound_messages status (failed):", name); // crew-debug-ok
      }
    }

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.OUTBOUND_EMAIL_FAILED,
      target_type: "case",
      target_id: caseId,
      payload: { error: errorCode },
    });

    return { error: errorCode };
  }
}
