/**
 * Taking delivery of an inbound email, whoever handed it to us.
 *
 * This used to live inside the Gmail poller, tangled with `gmail_v1.Schema$Message`
 * objects and an authenticated client. That made the most consequential
 * decisions in the whole email path — is this a claim or a newsletter, is it a
 * new case or a reply to an open one — reachable only by putting a real
 * message in a real inbox and waiting for the cron to pick it up.
 *
 * Which is exactly what testing the product had become: a person typing into
 * Gmail and WhatsApp for an afternoon, walking one path per afternoon.
 *
 * Everything Gmail-specific stays in the poller: fetching, decoding, marking
 * read, downloading attachment parts. What is left here is the part that would
 * be identical if the mail arrived by IMAP, by a webhook, or from a rehearsal
 * script — and it is the part worth exercising before every deploy.
 */

import "server-only";

import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { cases, claimMessages } from "@/lib/db/schema";
import { threadLookup } from "@/server/email/thread-lookup";
import { classifyInboundEmailForIntake } from "@/server/email/relevance-prefilter";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { enTenant } from "@/data/scope";
import { reabrirSiEraNoRelevante } from "@/server/cases/reabrir-no-relevante";

export interface InboundEmail {
  tenantId: string;
  /** `email` for the real mailbox, `email_sim` for a rehearsal. */
  channel: "email" | "email_sim";
  fromAddr: string;
  toAddr?: string | null;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  /** Provider's own id for the message. */
  messageId: string;
  /** Provider's own thread id, when it has one. */
  threadId?: string | null;
  /** RFC 2822 headers, for threading a reply onto its case. */
  inReplyTo?: string | null;
  references?: string | null;
  /** Everything, for the record. Empty is fine. */
  headers?: Array<{ name: string; value: string }>;
  rawPayload?: unknown;
}

export type InboundEmailResult =
  | { outcome: "processed"; caseId: string; claimMessageId: string; isNewCase: boolean }
  | { outcome: "skipped"; reason: string };

/**
 * Find or open the case this email belongs to, and record the message.
 *
 * Does not run the extractor: the caller decides when, because the Gmail
 * poller wants attachments stored first and a rehearsal wants to await the
 * whole thing.
 *
 * The prefilter runs only for mail that is not already part of a conversation.
 * A reply on an open claim is never a newsletter, whatever it looks like — and
 * an over-eager filter dropping someone's answer is far worse than a promo
 * landing in the queue for an analyst to close.
 */
export async function ingestInboundEmail(
  email: InboundEmail
): Promise<InboundEmailResult> {
  const { tenantId, channel } = email;

  const { existingCaseId } = await threadLookup(
    tenantId,
    email.inReplyTo ?? "",
    email.references ?? "",
    email.subject
  );

  if (!existingCaseId) {
    const prefilter = classifyInboundEmailForIntake({
      fromAddr: email.fromAddr,
      subject: email.subject,
      bodyText: email.bodyText,
      bodyHtml: email.bodyHtml ?? "",
      headers: email.headers ?? [],
    });

    if (prefilter.action === "skip") {
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: null,
        event_type: AuditEvent.EMAIL_FILTERED,
        target_type: "gmail_message",
        target_id: null,
        payload: {
          action: "prefilter_skip",
          message_id: email.messageId,
          reason: prefilter.reason,
          category: prefilter.category,
        },
      });
      return { outcome: "skipped", reason: prefilter.reason ?? "prefilter" };
    }
  }

  let caseId = existingCaseId;

  if (!caseId) {
    try {
      const created = firstRow(
        await enTenant({ tenantId }, (db) =>
          db
            .insert(cases)
            .values({
              tenant_id: tenantId,
              channel,
              status: "recibido",
              email_message_id: email.messageId,
              email_thread_id: email.threadId ?? null,
              // Unknown until the extractor decides. Seeding `true` made every
              // un-analysed message read as "¿Es reclamo? Sí" in the UI, and the
              // value stuck forever when extraction failed.
              is_claim: null,
              claim_type: null,
            })
            .returning({ id: cases.id })
        )
      );
      if (!created) return { outcome: "skipped", reason: "case_insert_no_row" };
      caseId = created.id;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      // A unique violation means a previous partial run already opened the
      // case. Treat it as done rather than opening a second one.
      if (code === "23505") return { outcome: "skipped", reason: "duplicate" };
      console.error("[inbound-email] case insert failed:", code); // crew-debug-ok
      throw new Error(`case_insert_failed: ${code ?? "unknown"}`);
    }
  }

  const claimMessageId = await insertInboundMessage(caseId, email);
  if (!claimMessageId) throw new Error("claim_message_insert_failed");

  /*
   * Si el caso estaba dado por «no es una denuncia», vuelve al flujo.
   *
   * Alguien escribe «hola», queda clasificado como no-denuncia, y después manda
   * la denuncia de verdad: sin esto ese mensaje se guardaba y no lo leía nadie,
   * porque el worker no arranca desde `no_relevante`.
   *
   * Va acá y no en el worker a propósito: el disparador tiene que ser que una
   * PERSONA mandó un mensaje, no que algo despachó una extracción.
   */
  if (existingCaseId) {
    await reabrirSiEraNoRelevante(caseId, tenantId);
  }

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: null,
    event_type: AuditEvent.EMAIL_RECEIVED,
    target_type: "case",
    target_id: caseId,
    payload: {
      action: existingCaseId ? "thread_update" : "new_case",
      message_id: email.messageId,
      channel,
    },
  });

  return {
    outcome: "processed",
    caseId,
    claimMessageId,
    isNewCase: !existingCaseId,
  };
}

async function insertInboundMessage(
  caseId: string,
  email: InboundEmail
): Promise<string | null> {
  try {
    const inserted = firstRow(
      await enTenant({ tenantId: email.tenantId }, (db) =>
        db
          .insert(claimMessages)
          .values({
            case_id: caseId,
            tenant_id: email.tenantId,
            direction: "inbound",
            provider: email.channel === "email_sim" ? "simulated" : "gmail",
            provider_message_id: email.messageId,
            thread_id: email.threadId ?? null,
            in_reply_to: email.inReplyTo ?? null,
            from_addr: email.fromAddr,
            to_addr: email.toAddr ?? null,
            subject: email.subject,
            body_text: email.bodyText,
            body_html: email.bodyHtml ?? null,
            headers: email.headers ?? [],
            raw_payload: email.rawPayload ?? {},
            status: "received",
            received_at: new Date().toISOString(),
          })
          .returning({ id: claimMessages.id })
      )
    );
    return inserted?.id ?? null;
  } catch (err) {
    // Code only: the body and headers carry personal data.
    const code =
      (err as { code?: string })?.code ??
      (err instanceof Error ? err.name : "UnknownError");
    console.error("[inbound-email] claim_messages insert failed:", code); // crew-debug-ok
    return null;
  }
}
