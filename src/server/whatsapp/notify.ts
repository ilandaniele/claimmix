/**
 * Replying to the policyholder on WhatsApp.
 *
 * Inbound worked from day one; outbound did not. `sendWhatsAppText` existed in
 * cloud-api.ts with zero callers, so a claim arriving by WhatsApp was silently
 * swallowed: the case appeared in the inbox and the person who sent it got
 * nothing back. Email has had this since the beginning (server/email/dispatch),
 * which is why the gap went unnoticed — the product only looked half-finished
 * on one channel.
 *
 * Every send is recorded in `outbound_messages`, the same ledger email writes
 * to, so "what did we actually say to this person?" has one answer regardless
 * of channel.
 *
 * NOTHING HERE MAY THROW. A failed reply is a bad day for one claimant; a
 * failed reply that breaks intake loses the claim entirely. Errors are logged
 * and swallowed.
 */

import "server-only";

import { and, eq, isNull, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { cases, missingDocs, outboundMessages, requiredDocsConfig } from "@/lib/db/schema";
import { sendWhatsAppText } from "@/server/whatsapp/cloud-api";

export type WhatsAppReplyTemplate =
  | "wa_ack_complete"
  | "wa_ack_missing_docs"
  | "wa_ack_received";

export interface WhatsAppReplyResult {
  sent: boolean;
  template?: WhatsAppReplyTemplate;
  /** Why nothing was sent. Present only when `sent` is false. */
  reason?: "not_a_claim" | "case_not_found" | "send_failed" | "error";
}

/** Kept short on purpose: WhatsApp is read on a phone, often one-handed. */
const ACK_COMPLETE =
  "Recibimos tu denuncia y ya quedó registrada con todos los datos necesarios. " +
  "Un analista la va a revisar y te contactamos si hace falta algo más.";

const ACK_RECEIVED =
  "Recibimos tu mensaje y ya lo registramos. Un analista lo va a revisar a la brevedad.";

function renderMissingDocs(labels: string[]): string {
  const list = labels.map((l) => `• ${l}`).join("\n");
  return (
    "Recibimos tu denuncia y ya quedó registrada. Para poder avanzar necesitamos que nos envíes:\n\n" +
    `${list}\n\n` +
    "Podés mandarlos por acá mismo, como foto o archivo."
  );
}

/**
 * Sends the intake acknowledgement for a WhatsApp case.
 *
 * Call this only for a NEWLY CREATED case. A conversation where someone sends
 * three messages in a row must not answer three times, and the caller already
 * knows whether the case was created or matched to an existing thread.
 *
 * Runs inside the 24-hour customer service window (the person just wrote to
 * us), so the message is free-form and costs nothing. Anything sent after that
 * window would need an approved template and would be billable — which is
 * precisely why the acknowledgement goes out immediately rather than on a
 * schedule.
 */
export async function replyToWhatsAppIntake(opts: {
  caseId: string;
  tenantId: string;
  /** wa_id of the sender — digits only, no '+'. */
  to: string;
}): Promise<WhatsAppReplyResult> {
  const { caseId, tenantId, to } = opts;

  try {
    const [row] = await db
      .select({ is_claim: cases.is_claim, claim_type: cases.claim_type })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.tenant_id, tenantId)))
      .limit(1);

    if (!row) return { sent: false, reason: "case_not_found" };

    // The agent decided this is not a claim — marketing, spam, a wrong number.
    // Answering would spend a conversation and, worse, confirm to a spammer
    // that a human-ish system is on the other side. Silence is the right reply.
    if (row.is_claim === false) return { sent: false, reason: "not_a_claim" };

    let template: WhatsAppReplyTemplate;
    let body: string;
    let docKeysAsked: string[] = [];

    if (row.is_claim === null) {
      // Extraction failed or escalated: we genuinely do not know yet what this
      // is. Acknowledge receipt and promise nothing specific.
      template = "wa_ack_received";
      body = ACK_RECEIVED;
    } else {
      const pending = await db
        .select({ doc_key: missingDocs.doc_key })
        .from(missingDocs)
        .where(
          and(
            eq(missingDocs.case_id, caseId),
            eq(missingDocs.tenant_id, tenantId),
            isNull(missingDocs.satisfied_at)
          )
        );

      docKeysAsked = pending.map((d) => d.doc_key);

      if (docKeysAsked.length === 0) {
        template = "wa_ack_complete";
        body = ACK_COMPLETE;
      } else {
        // Human-readable labels live in required_docs_config, keyed by claim
        // type. Fall back to the raw key rather than dropping a document from
        // the list — an ugly line is better than a claim that stalls because we
        // never asked for something.
        const labelRows = row.claim_type
          ? await db
              .select({ doc_key: requiredDocsConfig.doc_key, label_es: requiredDocsConfig.label_es })
              .from(requiredDocsConfig)
              .where(
                and(
                  eq(requiredDocsConfig.claim_type, row.claim_type),
                  inArray(requiredDocsConfig.doc_key, docKeysAsked)
                )
              )
          : [];

        const labelByKey = new Map(labelRows.map((r) => [r.doc_key, r.label_es]));
        template = "wa_ack_missing_docs";
        body = renderMissingDocs(docKeysAsked.map((k) => labelByKey.get(k) ?? k));
      }
    }

    const res = await sendWhatsAppText(to, body);

    await recordOutbound(caseId, tenantId, template, body, res.ok ? "sent" : "failed");

    if (!res.ok) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: "whatsapp.reply.send_failed",
          case_id: caseId,
          template,
        })
      );
      return { sent: false, template, reason: "send_failed" };
    }

    // Mark what we asked for, so a later reminder does not repeat the request
    // and an analyst can see the claimant was already chased.
    if (docKeysAsked.length > 0) {
      await db
        .update(missingDocs)
        .set({ requested_at: new Date().toISOString() })
        .where(
          and(
            eq(missingDocs.case_id, caseId),
            eq(missingDocs.tenant_id, tenantId),
            inArray(missingDocs.doc_key, docKeysAsked)
          )
        );
    }

    console.log(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "whatsapp.reply.sent",
        case_id: caseId,
        template,
        docs_requested: docKeysAsked.length,
      })
    );

    return { sent: true, template };
  } catch (err) {
    // Never propagate: intake already succeeded and must not be undone by a
    // messaging failure.
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "whatsapp.reply.error",
        case_id: caseId,
        error: err instanceof Error ? err.name : "UnknownError",
      })
    );
    return { sent: false, reason: "error" };
  }
}

/** Best-effort ledger write. Never blocks or fails the reply. */
async function recordOutbound(
  caseId: string,
  tenantId: string,
  template: WhatsAppReplyTemplate,
  body: string,
  status: "sent" | "failed"
): Promise<void> {
  try {
    await db.insert(outboundMessages).values({
      case_id: caseId,
      tenant_id: tenantId,
      channel: "whatsapp",
      template,
      rendered_body: body,
      status,
    });
  } catch {
    // The message may already have gone out; losing the ledger row must not
    // turn that into an error the caller sees.
  }
}
