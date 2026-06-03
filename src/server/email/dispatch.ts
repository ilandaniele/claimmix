/**
 * Outbound email dispatch service for ClaimMix.
 *
 * Coordinates the full outbound email pipeline:
 *   1. Render the template
 *   2. Insert an outbound_messages row (status='queued')
 *   3. Call EmailProvider.send() — provider-agnostic (IC8, AC12)
 *   4. Update outbound_messages row (status='sent' or 'failed')
 *   5. Write audit log
 *
 * Uses the service-role client for DB writes (system actor — no user context).
 * Import from here — do not call the provider or renderTemplate directly from routes.
 *
 * AC12: Confirmation receipt always sent for valid claims.
 * AC13: No Resend imports — only getEmailProvider() from postmark/index.ts.
 * AC16: In-Reply-To and References headers forwarded when inReplyToMessageId is set.
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { renderTemplate, type EmailTemplate } from "./render";
import { getEmailProvider } from "./postmark/index";
import { isSendSuccess } from "./provider";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

export interface DispatchOptions {
  caseId: string;
  tenantId: string;
  to: string;
  template: EmailTemplate;
  data: Record<string, unknown>;
  /** Original Postmark MessageID — used to thread the reply in the claimant's inbox. */
  inReplyToMessageId?: string;
}

/**
 * Dispatch an outbound email for a case.
 *
 * Does NOT throw — any error is caught and logged so intake flow is not disrupted.
 *
 * @param options - Dispatch options (caseId, tenantId, to, template, data)
 */
export async function dispatchOutboundEmail(options: DispatchOptions): Promise<void> {
  const { caseId, tenantId, to, template, data, inReplyToMessageId } = options;

  // ── 1. Render template ─────────────────────────────────────────────────────
  let rendered: { subject: string; html: string; text: string };
  try {
    rendered = renderTemplate(template, data);
  } catch (err) {
    const name = err instanceof Error ? err.name : "RenderError";
    console.error("[dispatch] Template render error:", name);
    return; // Do not throw.
  }

  const supabase = createServiceClient();

  // ── 2. Insert outbound_messages row (status='queued') ─────────────────────
  let outboundMsgId: string | undefined;
  try {
    const { data: inserted, error: insertError } = await (supabase as any)
      .from("outbound_messages")
      .insert({
        case_id: caseId,
        tenant_id: tenantId,
        channel: "email",
        template,
        rendered_body: rendered.html,
        status: "queued",
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("[dispatch] Failed to insert outbound_messages:", insertError.code);
    } else if (inserted) {
      outboundMsgId = (inserted as { id: string }).id;
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "DBError";
    console.error("[dispatch] DB insert exception:", name);
  }

  // ── 3. Send via EmailProvider (Postmark) ───────────────────────────────────
  // AC16: Build In-Reply-To / References headers when threading.
  const threadingHeaders: Array<{ Name: string; Value: string }> = [];
  if (inReplyToMessageId) {
    threadingHeaders.push({ Name: "In-Reply-To", Value: inReplyToMessageId });
    threadingHeaders.push({ Name: "References", Value: inReplyToMessageId });
  }

  const provider = getEmailProvider();
  const fromAddress = process.env.POSTMARK_FROM_ADDRESS ?? "";

  const sendResult = await provider.send({
    to,
    from: fromAddress,
    subject: rendered.subject,
    htmlBody: rendered.html,
    textBody: rendered.text,
    headers: threadingHeaders.length > 0 ? threadingHeaders : undefined,
  });

  // ── 4. Update outbound_messages row + write audit log ─────────────────────
  if (isSendSuccess(sendResult)) {
    // Postmark accepted the message.
    if (outboundMsgId) {
      try {
        await (supabase as any)
          .from("outbound_messages")
          .update({ status: "sent" })
          .eq("id", outboundMsgId);
      } catch (err) {
        const name = err instanceof Error ? err.name : "DBError";
        console.error("[dispatch] Failed to update outbound_messages status (sent):", name);
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
        provider_message_id: sendResult.providerMessageId,
      },
    });
  } else {
    // Provider returned an error.
    console.error("[dispatch] Email send failed, error code:", sendResult.errorCode);

    if (outboundMsgId) {
      try {
        await (supabase as any)
          .from("outbound_messages")
          .update({ status: "failed" })
          .eq("id", outboundMsgId);
      } catch (err) {
        const name = err instanceof Error ? err.name : "DBError";
        console.error("[dispatch] Failed to update outbound_messages status (failed):", name);
      }
    }

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.OUTBOUND_EMAIL_FAILED,
      target_type: "case",
      target_id: caseId,
      payload: { error: sendResult.errorCode },
    });
  }
}
