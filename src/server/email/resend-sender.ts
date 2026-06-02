/**
 * Resend outbound email sender for ClaimMix.
 *
 * Uses the official Resend SDK to deliver transactional emails.
 * The From address is configured via RESEND_FROM_ADDRESS env var.
 *
 * Error handling:
 *   - If Resend fails, the error is logged (code only — no PII) and an
 *     OUTBOUND_EMAIL_FAILED audit event is written.
 *   - Email failures do NOT throw — they must not crash the intake flow.
 *
 * AC12: Confirmation receipt always sent.
 * AC24: Templates mask DNI and policy_number before this module is called.
 *
 * Note: Postmark inbound webhook sends emails TO the intake inbox.
 *       Resend is used only for OUTBOUND (replies to claimants).
 */

import "server-only";
import { Resend } from "resend";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

/** Lazily initialise the Resend client so missing API key only errors at send-time. */
function getResendClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "[resend-sender] RESEND_API_KEY is not set. Configure this env var in Vercel."
    );
  }
  return new Resend(apiKey);
}

function getFromAddress(): string {
  const from = process.env.RESEND_FROM_ADDRESS;
  if (!from) {
    throw new Error(
      "[resend-sender] RESEND_FROM_ADDRESS is not set. Configure this env var in Vercel."
    );
  }
  return from;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** If set, adds In-Reply-To header so Resend threads the email in the claimant's inbox. */
  replyToMessageId?: string;
  tenantId: string;
  caseId: string;
}

/**
 * Send an outbound email via Resend.
 *
 * Does NOT throw on Resend failure — catches and logs the error code.
 * Writes an audit log entry on both success and failure.
 *
 * @param options - Email details (see SendEmailOptions)
 */
export async function sendEmail(options: SendEmailOptions): Promise<void> {
  let resend: Resend;
  let from: string;

  try {
    resend = getResendClient();
    from = getFromAddress();
  } catch (configErr) {
    const name = configErr instanceof Error ? configErr.name : "ConfigError";
    console.error("[resend-sender] Configuration error:", name);
    await writeAuditLog({
      tenant_id: options.tenantId,
      actor_id: null,
      event_type: AuditEvent.OUTBOUND_EMAIL_FAILED,
      target_type: "case",
      target_id: options.caseId,
      payload: { error: "configuration_error" },
    });
    return; // Do not throw — email failure must not crash the intake flow.
  }

  try {
    const headers: Record<string, string> = {};
    if (options.replyToMessageId) {
      headers["In-Reply-To"] = options.replyToMessageId;
      headers["References"] = options.replyToMessageId;
    }

    const { error } = await resend.emails.send({
      from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });

    if (error) {
      // Log Resend error name only — the error object may contain PII (To address).
      console.error("[resend-sender] Resend API error:", error.name);
      await writeAuditLog({
        tenant_id: options.tenantId,
        actor_id: null,
        event_type: AuditEvent.OUTBOUND_EMAIL_FAILED,
        target_type: "case",
        target_id: options.caseId,
        payload: { error: error.name },
      });
      return; // Do not throw.
    }

    await writeAuditLog({
      tenant_id: options.tenantId,
      actor_id: null,
      event_type: AuditEvent.OUTBOUND_EMAIL_SENT,
      target_type: "case",
      target_id: options.caseId,
      payload: { subject_prefix: options.subject.slice(0, 40) }, // partial subject — no PII
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error("[resend-sender] Unexpected error:", name);
    await writeAuditLog({
      tenant_id: options.tenantId,
      actor_id: null,
      event_type: AuditEvent.OUTBOUND_EMAIL_FAILED,
      target_type: "case",
      target_id: options.caseId,
      payload: { error: name },
    });
    // Do not throw.
  }
}
