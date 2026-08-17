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
import { labelForField, type FieldKind } from "@/lib/labels/claim-fields";
import { sendWhatsAppText } from "@/server/whatsapp/cloud-api";

export type WhatsAppReplyTemplate =
  | "wa_ack_complete"
  | "wa_ack_missing_docs"
  | "wa_ack_received"
  | "wa_specialist_escalation";

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

/**
 * A serious claim gets a person, and the claimant is told so.
 *
 * Email has escalated high and critical severity to a specialist since the
 * beginning (confirmations/orchestrate, branch B) and tells the claimant. On
 * WhatsApp the same crash produced a routine acknowledgement, which is the
 * wrong thing to send someone reporting an injury or a fire — and asking them
 * for five documents in that moment is worse.
 */
const ACK_SPECIALIST =
  "Recibimos tu denuncia y ya quedó registrada. Por las características de lo que nos contás, " +
  "la derivamos a un especialista que se va a comunicar con vos a la brevedad. " +
  "Si necesitás asistencia urgente, llamá a la línea de emergencias de tu póliza.";

/**
 * How many things we are willing to ask for in one message.
 *
 * Extraction routinely flags a dozen or more gaps — a real WhatsApp claim came
 * back with thirteen, including witnesses and the time of day. Sending someone
 * who just crashed their car a list of thirteen demands is the fastest way to
 * get no reply at all. Ask for a handful, get those, ask again.
 */
const MAX_ITEMS_PER_MESSAGE = 5;

/**
 * Compose the "we need a few things" message.
 *
 * Two things the first version got wrong, both visible in a real reply sent to
 * a real phone. It printed the raw key (`• dni_asegurado`), and it told the
 * claimant to send all of it "como foto o archivo" — when four of the four
 * items were facts to type, not files to photograph. Facts and documents are
 * now asked for separately, and each in the verb that fits.
 */
function renderMissingDocs(
  items: Array<{ label: string; kind: FieldKind }>,
  remaining: number
): string {
  const datos = items.filter((i) => i.kind === "dato");
  const documentos = items.filter((i) => i.kind === "documento");

  const bullets = (list: typeof items) => list.map((i) => `• ${i.label}`).join("\n");

  // The opener used to end in a colon and the first block opened with another
  // one, so a real reply read "…ya quedó registrada. Para poder avanzar:" and
  // then "Necesitamos que nos cuentes:" — two headings stacked, each promising
  // the list that only the second one introduces. The opener is now a closed
  // sentence and the "para empezar" nuance rides on the block heading, where
  // there is exactly one colon and it belongs to the list underneath it.
  const lead = remaining > 0 ? "Para empezar, necesitamos" : "Necesitamos";

  const blocks: string[] = [];
  if (datos.length > 0) {
    blocks.push(`${lead} que nos cuentes:\n\n${bullets(datos)}`);
  }
  if (documentos.length > 0) {
    blocks.push(
      datos.length > 0
        ? `Y que nos mandes:\n\n${bullets(documentos)}`
        : `${lead} que nos mandes:\n\n${bullets(documentos)}`
    );
  }

  const opener = "Recibimos tu denuncia y ya quedó registrada.";

  // Only mention photos when we actually asked for one.
  const how =
    documentos.length > 0
      ? "Podés responder por acá mismo; las fotos o archivos mandalos por este chat."
      : "Podés responder por acá mismo.";

  const closer =
    remaining > 0 ? `${how} Después te pedimos el resto.` : how;

  return `${opener}\n\n${blocks.join("\n\n")}\n\n${closer}`;
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
      .select({
        is_claim: cases.is_claim,
        claim_type: cases.claim_type,
        severity: cases.severity,
      })
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
    } else if (row.severity === "high" || row.severity === "critical") {
      // Mirrors branch B of the email orchestrator. Checked BEFORE the missing
      // documents branch on purpose: someone reporting an injury or a fire
      // should hear that a specialist is coming, not receive a list of five
      // documents to photograph. An analyst chases the paperwork afterwards.
      template = "wa_specialist_escalation";
      body = ACK_SPECIALIST;
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

      const pendingKeys = pending.map((d) => d.doc_key);

      // Only the items that actually appear in the message count as asked for.
      // Stamping requested_at on all thirteen would tell a later reminder the
      // claimant had already been chased for things nobody ever mentioned.
      docKeysAsked = pendingKeys.slice(0, MAX_ITEMS_PER_MESSAGE);

      if (pendingKeys.length === 0) {
        template = "wa_ack_complete";
        body = ACK_COMPLETE;
      } else {
        // The tenant's own wording wins when it has one; everything else goes
        // through the shared label table. Nothing reaches the claimant as a
        // raw key — required_docs_config only covers documents configured per
        // claim type, and most gaps the extractor reports are not in it.
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

        const overrideByKey = new Map(labelRows.map((r) => [r.doc_key, r.label_es]));
        template = "wa_ack_missing_docs";
        body = renderMissingDocs(
          docKeysAsked.map((k) => labelForField(k, overrideByKey.get(k))),
          pendingKeys.length - docKeysAsked.length
        );
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
