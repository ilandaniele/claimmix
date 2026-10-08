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
 *   2b. claim_messages.thread_id (inbound, mismo proveedor, mismo remitente, el mensaje al que contesta)
 *      → la respuesta del asegurado a su propio mail, que no cita ningún id nuestro.
 *
 * Resolution strategy:
 *   a. Check InReplyTo (most precise — direct reply to a specific message)
 *   b. Fall back to References (space-separated chain — check each token)
 *   c. If neither matches: return { existingCaseId: undefined }
 *
 * The outbound claim_messages check is tried first because it is the common
 * case once W4/W5 are deployed: claimants reply to provider-sent outbound
 * messages whose provider_message_id is stored in claim_messages.
 *
 * Whichever step matches, the case is returned only if the sender already
 * takes part in it (senderParticipates): headers and subject say which
 * conversation a mail claims to belong to, not who sent it.
 */

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { remitenteVerificado } from "@/core/email/autenticacion";
import { enTenant, type TenantContext } from "@/data/scope";
import { cases, claimMessages } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";
import { bareAddress } from "@/lib/email/reserved";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";

/** The channels whose `cases.email_thread_id` is an email thread. */
const EMAIL_CHANNELS = ["email", "email_sim"];

/**
 * Los canales donde el asunto «Caso #<uuid>» pega un mail con su caso. Suma
 * `web`: quien denunció por el formulario sólo tiene nuestro mail para
 * contestar, y ahí el asunto es lo único que sobrevive si su cliente pierde las
 * cabeceras. El paso 2 sigue sin `web`: ese caso no tiene hilo de mail propio.
 */
const CANALES_PASO_3 = [...EMAIL_CHANNELS, "web"];

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
 * @param subject     - Value of the Subject header (may carry "Caso #<uuid>")
 * @param fromAddr    - Value of the From header; must already take part in the case
 * @param headers     - cabeceras del mensaje, de donde sale si el remitente es de quien dice
 * @param channel     - `email` exige un Authentication-Results de Gmail alineado con el From; `email_sim` sólo que no haya fallado
 * @param threadId    - id de hilo del proveedor (Gmail: msg.threadId; ensayo: thread.<run>.<escenario>); sólo junta mails del mismo remitente y sólo con el que contesta
 * @returns { existingCaseId?: string }
 */
export async function threadLookup(
  tenantId: string,
  inReplyTo: string,
  references: string,
  subject: string,
  fromAddr: string,
  headers: unknown = [],
  channel: "email" | "email_sim" = "email_sim",
  threadId: string | null = null
): Promise<ThreadLookupResult> {
  // Sin remitente verificado no entra a ningún caso: abre el suyo.
  if (!remitenteVerificado(headers, fromAddr, channel)) {
    logger.warn({ via: "authentication_results" }, "thread_lookup.sender_not_verified");
    return {};
  }
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  // Collect candidate thread IDs from both headers (angle brackets stripped).
  const candidates = buildCandidates(inReplyTo, references);
  const sender = bareAddress(fromAddr);

  // A match names the conversation the mail claims to belong to. It joins the
  // case only if the sender is already part of it; otherwise the next step
  // gets its turn and, failing all, the mail opens a case of its own.
  const onlyIfParticipant = async (caseId: string, via: string) => {
    if (await senderParticipates(tenantCtx, caseId, sender)) return caseId;
    logger.warn({ case_id: caseId, via }, "thread_lookup.sender_not_in_case");
    return undefined;
  };

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
      const caseId = await onlyIfParticipant(claimMsgRow.case_id, "in_reply_to");
      if (caseId) return { existingCaseId: caseId };
    }
  } catch (err) {
    logger.error({ code: errorCode(err) }, "thread_lookup.claim_messages_error");
    // Non-fatal — fall through to legacy check.
  }

  // ── 2. Legacy path: cases.email_thread_id ────────────────────────────────
  // This covers:
  //   - Any rows that predate the claim_messages table (migration 0009)
  // No cubre las respuestas de Gmail al mail original: ahí email_thread_id guarda
  // el id hex de Gmail, que no aparece en ninguna cabecera. Queda como legado.
  try {
    const caseRow = candidates.length === 0 ? null : firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: cases.id, email_thread_id: cases.email_thread_id })
          .from(cases)
          .where(
            and(
              // A WhatsApp case keeps the claimant's phone number here, and a
              // phone number is something anyone can type into a header.
              inArray(cases.channel, EMAIL_CHANNELS),
              inArray(cases.email_thread_id, candidates)
            )
          )
          .limit(1)
      )
    );

    if (caseRow) {
      const caseId = await onlyIfParticipant(caseRow.id, "email_thread_id");
      if (caseId) return { existingCaseId: caseId };
    }
  } catch (err) {
    logger.error({ code: errorCode(err) }, "thread_lookup.cases_error");
    return { existingCaseId: undefined };
  }

  // ── 2b. El hilo del proveedor donde el remitente ya escribió ─────────────
  // La respuesta del asegurado a su propio mail trae en In-Reply-To el
  // Message-ID RFC de ese mail, que sólo guardamos en las cabeceras de su fila;
  // Gmail sí la deja en el mismo hilo. Ese hilo lo arma Gmail con asunto y
  // References, que cualquiera tipea: sólo vale la fila entrante del mismo
  // remitente en ese hilo a cuyo mensaje contesta, y aun así pasa por
  // onlyIfParticipant. No se elige por fecha: un mismo remitente puede tener
  // dos casos en un hilo que Gmail agrupó por asunto. Sin cabeceras de
  // respuesta no es una respuesta; con dos casos posibles, sigue el asunto.
  if (threadId && sender && candidates.length > 0) {
    try {
      const rows = await enTenant(tenantCtx, (db) =>
        db
          .select({
            case_id: claimMessages.case_id,
            from_addr: claimMessages.from_addr,
            provider_message_id: claimMessages.provider_message_id,
            headers: claimMessages.headers,
          })
          .from(claimMessages)
          .where(
            and(
              eq(claimMessages.direction, "inbound"),
              // Un caso de WhatsApp guarda el teléfono como thread_id.
              eq(claimMessages.provider, channel === "email_sim" ? "simulated" : "gmail"),
              eq(claimMessages.thread_id, threadId)
            )
          )
      );
      const contestados = new Set(
        rows
          .filter(
            (m) =>
              bareAddress(m.from_addr) === sender &&
              idsDeLaFila(m, channel).some((id) => candidates.includes(id))
          )
          .map((m) => m.case_id)
      );
      if (contestados.size === 1) {
        const caseId = await onlyIfParticipant([...contestados][0], "provider_thread");
        if (caseId) return { existingCaseId: caseId };
      }
    } catch (err) {
      logger.error({ code: errorCode(err) }, "thread_lookup.provider_thread_error");
      // No es fatal: sigue el asunto.
    }
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
            // Un caso de WhatsApp no tiene hilo de mail: aunque alguien escriba
            // su id en el asunto, no se pega. La guardia de participante ya lo
            // cubre; esto lo dice en la consulta, que es donde se lee.
            .where(and(eq(cases.id, subjectCaseId), inArray(cases.channel, CANALES_PASO_3)))
            .limit(1)
        )
      );
      if (caseRow) {
        const caseId = await onlyIfParticipant(caseRow.id, "subject");
        if (caseId) return { existingCaseId: caseId };
      }
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "DBError";
      logger.error({ code }, "thread_lookup.subject_case_lookup_error");
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
 * Whether `sender` already takes part in the case: wrote to it, or was written to.
 *
 * Headers and subject are typed by whoever sends the mail. A WhatsApp case
 * keeps the claimant's phone number as its thread id and every outbound mail
 * prints the case number, so on their own they let a stranger who knows a
 * phone number or a case id file mail — and attachments — onto someone else's
 * claim, skip the prefilter, reopen a closed case and become the newest
 * inbound sender, which is who the agent answers next.
 *
 * Compared by bare address: `from_addr` and `to_addr` are stored as the header
 * came, display name and all. A lookup that fails counts as "not a participant".
 */
async function senderParticipates(
  tenantCtx: TenantContext,
  caseId: string,
  sender: string
): Promise<boolean> {
  if (!sender) return false;
  try {
    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({
          direction: claimMessages.direction,
          from_addr: claimMessages.from_addr,
          to_addr: claimMessages.to_addr,
        })
        .from(claimMessages)
        .where(eq(claimMessages.case_id, caseId))
    );
    return rows.some(
      (m) => bareAddress(m.direction === "inbound" ? m.from_addr : m.to_addr) === sender
    );
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "DBError";
    logger.error({ code }, "thread_lookup.participants_error");
    return false;
  }
}

/** `"<abc@mail>"` → `"abc@mail"`: así se comparan los ids. */
function sinAngulos(raw: string): string {
  return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * Los ids con que una respuesta puede nombrar a esta fila entrante: su
 * Message-ID RFC, de las cabeceras guardadas. El simulado no manda cabeceras y
 * el ensayo pone el id en provider_message_id.
 */
function idsDeLaFila(
  m: { provider_message_id: string | null; headers: unknown },
  channel: "email" | "email_sim"
): string[] {
  const cabecera = Array.isArray(m.headers)
    ? (m.headers as Array<{ name?: string; value?: string }>).find(
        (h) => h?.name?.toLowerCase() === "message-id"
      )?.value
    : undefined;
  const ids = [cabecera, channel === "email_sim" ? m.provider_message_id : null];
  return ids.flatMap((id) => (id ? [sinAngulos(id)] : []));
}

/**
 * Build a deduplicated list of candidate thread IDs from In-Reply-To and References.
 * Normalizes angle brackets (e.g. "<abc@mail>" → "abc@mail") and filters empty strings.
 */
function buildCandidates(inReplyTo: string, references: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  const addCandidate = (raw: string) => {
    const normalized = sinAngulos(raw);
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
