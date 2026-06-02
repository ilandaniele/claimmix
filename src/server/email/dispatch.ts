/**
 * Outbound email dispatch service for ClaimMix.
 *
 * Coordinates the full outbound email pipeline:
 *   1. Render the template
 *   2. Insert an outbound_messages row (status='queued')
 *   3. Call sendEmail via Resend
 *   4. Update outbound_messages row (status='sent' or 'failed')
 *   5. Write audit log
 *
 * Uses the service-role client for DB writes (system actor — no user context).
 * Import from here — do not call sendEmail or renderTemplate directly from routes.
 *
 * AC12: Confirmation receipt always sent for valid claims.
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { renderTemplate, type EmailTemplate } from "./render";
import { sendEmail } from "./resend-sender";

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

  // ── 3. Send via Resend ─────────────────────────────────────────────────────
  // sendEmail never throws — it logs failures and writes audit events internally.
  await sendEmail({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyToMessageId: inReplyToMessageId,
    tenantId,
    caseId,
  });

  // ── 4. Update outbound_messages row ───────────────────────────────────────
  if (outboundMsgId) {
    try {
      // We don't have a direct way to know if Resend succeeded from here (sendEmail
      // doesn't return a status). For MVP, we optimistically mark as 'sent' and rely
      // on the audit log events (OUTBOUND_EMAIL_SENT / OUTBOUND_EMAIL_FAILED) for
      // the true delivery status.
      await (supabase as any)
        .from("outbound_messages")
        .update({ status: "sent" })
        .eq("id", outboundMsgId);
    } catch (err) {
      const name = err instanceof Error ? err.name : "DBError";
      console.error("[dispatch] Failed to update outbound_messages status:", name);
    }
  }
}
