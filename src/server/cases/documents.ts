/**
 * The documents a claim needs, asked for and recognised when they arrive.
 *
 * Three things were missing and they only make sense together.
 *
 * `required_docs_config` — which papers each kind of claim needs — was read by
 * nothing. The table has been seeded since the beginning and the real intake
 * path never consulted it, so nobody was ever asked for the photos of the
 * damage, the fire brigade report, or the police report.
 *
 * Nothing put those requests in front of the claimant either: the ask list was
 * built from missing fields, and a document is not a field.
 *
 * And `satisfied_at` was only ever written by an analyst clicking in the app.
 * A person could send exactly the photo we asked for and the request stayed
 * open, so the next round asked again. Asking for something that already
 * arrived is the failure this whole day has been about.
 */

import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { claimAttachments, missingDocs, requiredDocsConfig } from "@/lib/db/schema";
import { callGemini } from "@/server/ai/gemini-extractor";
import { canonicalFieldKey, labelForField } from "@/lib/labels/claim-fields";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

/**
 * Register the documents this kind of claim needs.
 *
 * Tenant configuration, not our table of defaults: an insurer that does not
 * want the friendly accident report should be able to stop asking for it by
 * editing a row, and that only works if this reads the database.
 *
 * Insert-if-absent, so re-extraction does not resurrect a document the
 * claimant already sent.
 */
export async function seedRequiredDocs(
  caseId: string,
  tenantId: string,
  claimType: string | null | undefined
): Promise<void> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  if (!claimType) return;

  try {
    const configured = await enTenant(tenantCtx, (db) =>
      db
        .select({ doc_key: requiredDocsConfig.doc_key })
        .from(requiredDocsConfig)
        .where(
          and(
            eq(requiredDocsConfig.claim_type, claimType),
            // Sólo los obligatorios. Un documento opcional —la denuncia
            // policial de un cristal roto, que sólo aplica si hubo
            // vandalismo— no lo pide el agente, porque analyzeGaps filtra por
            // `required`. Sembrarlo igual dejaba un pendiente que nadie iba a
            // reclamar nunca y que el analista tenía que descartar a mano en
            // cada caso.
            eq(requiredDocsConfig.required, true)
          )
        )
    );

    if (configured.length === 0) return;

    const existing = await enTenant(tenantCtx, (db) =>
      db
        .select({ doc_key: missingDocs.doc_key })
        .from(missingDocs)
        .where(eq(missingDocs.case_id, caseId))
    );

    const known = new Set(existing.map((r) => r.doc_key));
    const fresh = configured.map((c) => c.doc_key).filter((k) => !known.has(k));
    if (fresh.length === 0) return;

    await enTenant(tenantCtx, (db) =>
      db.insert(missingDocs).values(
        fresh.map((doc_key) => ({
          case_id: caseId,
          tenant_id: tenantId,
          doc_key,
          satisfied_at: null,
        }))
      )
    );
  } catch (err) {
    console.error("[documents] seed failed:", errCode(err), "case:", caseId);
  }
}

/** Document keys still outstanding on this case. */
export async function pendingDocKeys(
  caseId: string,
  tenantId: string
): Promise<string[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({ doc_key: missingDocs.doc_key })
        .from(missingDocs)
        .where(
          and(
            eq(missingDocs.case_id, caseId),
            isNull(missingDocs.satisfied_at),
            // A document the claimant told us does not exist is not
            // outstanding. Asking again for the accident report they already
            // said nobody filled in is the same failure as asking for the photo
            // we already have, arriving by a different door.
            isNull(missingDocs.declined_at)
          )
        )
    );

    // Only the ones that are genuinely files. missing_docs also holds
    // low-confidence field keys, which the field branches already handle —
    // asking for `hora_siniestro` as an attachment is the old bug in reverse.
    return rows
      .map((r) => r.doc_key)
      .filter((key) => labelForField(key).kind === "documento");
  } catch (err) {
    console.error("[documents] pending fetch failed:", errCode(err));
    return [];
  }
}

// ── Recognising what arrived ─────────────────────────────────────────────────

/** Types worth showing a model. A PDF or a heic is not something it can read here. */
const VIEWABLE = /^image\/(jpeg|png|webp)$/i;

interface AttachmentRow {
  id: string;
  filename: string;
  contentType: string;
  storagePath: string | null;
}

/**
 * Work out which pending document each new attachment satisfies, and close it.
 *
 * The model is shown the image and the list of documents we are waiting for,
 * and answers with one of those keys or nothing. It is a closed question with
 * a known answer set, which is the kind a model is reliable at — unlike
 * "what should we do next", which stays in code.
 *
 * Conservative on purpose: an unrecognised photo leaves every request open. A
 * document wrongly marked as received disappears from the analyst's list and
 * nobody finds out until the claim stalls; one asked for twice is a nuisance.
 */
export async function reconcileAttachments(
  caseId: string,
  tenantId: string,
  claimTypeLabel: string | null
): Promise<void> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const pending = await pendingDocKeys(caseId, tenantId);
    if (pending.length === 0) return;

    const attachments = await unmatchedAttachments(caseId, tenantId);
    if (attachments.length === 0) return;

    const satisfied = new Set<string>();
    /** Qué adjunto cerró qué documento, para poder anotarlo después. */
    const marcados: Array<[string, string]> = [];

    for (const attachment of attachments) {
      const remaining = pending.filter((k) => !satisfied.has(k));
      if (remaining.length === 0) break;

      const key = await identifyDocument(attachment, remaining, claimTypeLabel);
      if (key) {
        satisfied.add(key);
        marcados.push([attachment.id, key]);
      }
    }

    if (satisfied.size === 0) return;

    await enTenant(tenantCtx, (db) =>
      db
        .update(missingDocs)
        .set({ satisfied_at: new Date().toISOString() })
        .where(
          and(
            eq(missingDocs.case_id, caseId),
            isNull(missingDocs.satisfied_at),
            inArray(missingDocs.doc_key, [...satisfied])
          )
        )
    );

    /*
     * Y se anota en el adjunto CUÁL cerró, que es lo que evita volver a
     * ofrecerlo. Si esto falla, el pedido queda cerrado igual y el archivo se
     * sigue ofreciendo: molesto, no incorrecto.
     */
    for (const [attachmentId, docKey] of marcados) {
      try {
        await enTenant(tenantCtx, (db) =>
          db
            .update(claimAttachments)
            .set({ matched_doc_key: docKey })
            .where(eq(claimAttachments.id, attachmentId))
        );
      } catch (err) {
        console.error("[documents] no se pudo marcar el adjunto:", errCode(err));
      }
    }

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.DOCUMENTS_RECEIVED,
      target_type: "case",
      target_id: caseId,
      payload: { doc_keys: [...satisfied] },
    });

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "documents.reconciled",
        case_id: caseId,
        satisfied: [...satisfied],
      })
    );
  } catch (err) {
    console.error("[documents] reconcile failed:", errCode(err), "case:", caseId);
  }
}

/** Attachments stored on this case. */
async function unmatchedAttachments(
  caseId: string,
  tenantId: string
): Promise<AttachmentRow[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const rows = await enTenant(tenantCtx, (db) =>
    db
      .select({
        id: claimAttachments.id,
        filename: claimAttachments.file_name,
        contentType: claimAttachments.content_type,
        storagePath: claimAttachments.storage_path,
      })
      .from(claimAttachments)
      .where(
        and(
          eq(claimAttachments.case_id, caseId),
          /*
           * Los que TODAVÍA no coincidieron con ningún documento.
           *
           * La función se llama `unmatchedAttachments` y devolvía todos: no
           * había dónde guardar cuál ya había coincidido, así que el nombre era
           * una aspiración. Cada mensaje nuevo volvía a ofrecerle al modelo las
           * fotos viejas para tapar los documentos que faltan — con cuatro
           * adjuntos y ocho vueltas, treinta y dos identificaciones para cuatro
           * archivos, y una posibilidad más de clasificar mal en cada una.
           *
           * Las filas anteriores a la columna tienen NULL y se siguen
           * ofreciendo, que es el comportamiento de siempre: nadie puede
           * reconstruir qué cerraron.
           */
          isNull(claimAttachments.matched_doc_key)
        )
      )
  );

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename ?? "",
    contentType: r.contentType ?? "",
    storagePath: r.storagePath,
  }));
}

/**
 * Ask which of the outstanding documents this file is.
 *
 * Returns null on anything short of a confident match — including a file the
 * model cannot see, where the filename alone is the only evidence and rarely
 * enough.
 */
async function identifyDocument(
  attachment: AttachmentRow,
  pending: string[],
  claimTypeLabel: string | null
): Promise<string | null> {
  const options = pending
    .map((key) => `- ${key}: ${labelForField(key).label}`)
    .join("\n");

  const prompt = `Un asegurado mandó un archivo para su denuncia${
    claimTypeLabel ? ` de ${claimTypeLabel}` : ""
  }.
Estamos esperando estos documentos:

${options}

Decidí cuál de esos documentos es el archivo. Si no podés reconocerlo con
seguridad, o si es otra cosa, devolvé null. Es preferible no reconocerlo a
darlo por recibido equivocado: un documento marcado como recibido desaparece
de la lista del analista y nadie se entera hasta que el reclamo se traba.

Nombre del archivo: ${attachment.filename}
Tipo: ${attachment.contentType}

Devolvé JSON: {"doc_key": "<clave exacta de la lista>" | null}`;

  try {
    const media = VIEWABLE.test(attachment.contentType)
      ? await inlineFor(attachment)
      : undefined;

    const { text } = await callGemini(
      prompt,
      "Mirá el archivo y respondé con la clave del documento, o null.",
      undefined,
      undefined,
      media ? [media] : undefined
    );
    if (!text) return null;

    const parsed = JSON.parse(text) as { doc_key?: unknown };
    const key = typeof parsed.doc_key === "string" ? parsed.doc_key.trim() : "";

    // Only a key we actually asked for. A model that invents one must not
    // close a request that does not exist.
    return pending.includes(key) ? key : null;
  } catch (err) {
    console.error("[documents] identify failed:", errCode(err));
    return null;
  }
}

/** Fetch the bytes so the model can look at the image. */
async function inlineFor(
  attachment: AttachmentRow
): Promise<{ mimeType: string; data: string } | undefined> {
  if (!attachment.storagePath) return undefined;
  try {
    const { readAttachment } = await import("@/server/storage/claim-attachments-bucket");
    const bytes = await readAttachment(attachment.storagePath);
    if (!bytes) return undefined;
    return { mimeType: attachment.contentType, data: bytes.toString("base64") };
  } catch {
    // Reading the file back is a nicety, not a requirement: without it the
    // model decides on the filename alone, which is rarely enough — and it
    // answers null, which is the safe direction.
    return undefined;
  }
}

function errCode(err: unknown): string {
  return (
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.name : "UnknownError")
  );
}

// ── When there is nothing to send ────────────────────────────────────────────

/**
 * Phrases that might be someone telling us a document does not exist.
 *
 * A gate, not a decision. Every inbound message would otherwise cost a model
 * call to answer "no" — most replies are people sending things, not declining
 * them. What passes this filter goes to the model; what the model says is
 * still checked against the list we actually asked for.
 *
 * Deliberately loose. A false positive costs one call; a false negative means
 * the person said "no tenemos parte" and we ask for it again next round.
 */
const MIGHT_BE_DECLINING =
  /\b(no|nunca|ning[uú]n|ninguna|tampoco)\b[^.!?]{0,60}\b(tengo|tenemos|ten[ií]a|hay|hubo|hice|hicimos|complet|llen|firm|labr|existe|corresponde|aplica|puedo|pude|dispon|cuento|qued[oó]|sac|pidi|dieron|entreg)/i;

/**
 * Close the requests the claimant has just told us cannot be satisfied.
 *
 * Most crashes have no friendly accident report — our own message says "si lo
 * completaron" — and until now a person answering "no completamos ninguno" had
 * no way to be heard. The request stayed open, the next round asked again, and
 * the case sat in `confirmacion_pendiente` until the abandonment sweep closed
 * it two weeks later as though they had never replied.
 *
 * Recorded as declined, never as received: nothing arrived. An analyst reading
 * "received" would go looking for a file. This has to read as "they told us
 * there isn't one", which is a different fact and sometimes one worth pushing
 * back on — so the note keeps what they said.
 *
 * The direction of caution flips here, and on purpose. Everywhere else we
 * refuse to close a request we are unsure about. Here the risk of closing
 * wrongly is that an analyst asks for the document on the phone; the risk of
 * not closing is that we badger someone for a piece of paper that does not
 * exist until the case dies of it. Still conservative — a bare "no" closes
 * nothing — but it does not demand certainty.
 */
export async function resolveDeclinedDocs(
  caseId: string,
  tenantId: string,
  latestMessageText: string | null | undefined,
  /**
   * The document keys we have actually put in front of this person.
   *
   * The guard that matters. A rehearsal caught the opening message of a claim
   * — "choqué ayer... No hubo heridos" — waiving all three documents at once:
   * the phrase tripped the gate, the model was asked which documents the
   * person was refusing, and it answered with the whole list. Nobody had asked
   * for anything yet. The claim went straight to "ya tenemos todo".
   *
   * A request that was never made cannot be refused. Passing what we asked for
   * makes that a fact rather than a hope about the model's judgement.
   */
  alreadyAsked: string[]
): Promise<void> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const said = (latestMessageText ?? "").trim();
  if (said.length === 0) return;
  if (alreadyAsked.length === 0) return;

  try {
    const asked = new Set(alreadyAsked);
    const pending = (await pendingDocKeys(caseId, tenantId)).filter((k) => asked.has(k));
    if (pending.length === 0) return;
    if (!MIGHT_BE_DECLINING.test(said)) return;

    const declined = await identifyDeclined(said, pending);
    if (declined.length === 0) return;

    await enTenant(tenantCtx, (db) =>
      db
        .update(missingDocs)
        .set({ declined_at: new Date().toISOString(), declined_note: said.slice(0, 500) })
        .where(
          and(
            eq(missingDocs.case_id, caseId),
            isNull(missingDocs.satisfied_at),
            isNull(missingDocs.declined_at),
            inArray(missingDocs.doc_key, declined)
          )
        )
    );

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.DOCUMENTS_DECLINED,
      target_type: "case",
      target_id: caseId,
      payload: { doc_keys: declined, note: said.slice(0, 500) },
    });

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "documents.declined",
        case_id: caseId,
        declined,
      })
    );
  } catch (err) {
    console.error("[documents] decline check failed:", errCode(err), "case:", caseId);
  }
}

/** For comparing a quote with the message: accents and spacing vary, the words do not. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ask which of the outstanding documents the person is saying they do not have.
 *
 * Closed question, known answer set — the kind a model is reliable at. Anything
 * it returns that we were not waiting for is dropped.
 */
async function identifyDeclined(said: string, pending: string[]): Promise<string[]> {
  const options = pending
    .map((key) => `- ${key}: ${labelForField(key).label}`)
    .join("\n");

  const prompt = `Un asegurado está respondiendo a un pedido de documentación para su denuncia.

Le pedimos estos documentos:

${options}

Esto fue lo que contestó:
"""${said.slice(0, 1500)}"""

¿De cuáles de esos documentos está diciendo que NO existe, que no lo tiene, que
no lo completaron o que no se lo dieron?

Por cada uno que incluyas, copiá TEXTUALMENTE el fragmento de su mensaje donde
lo niega. Si no podés señalar las palabras exactas, no lo incluyas: significa
que lo estás deduciendo, y deducir acá le saca a la persona un pedido que nadie
va a volver a hacerle.

Cuidado con las negaciones que no son sobre documentos. "No hubo heridos" es
una respuesta sobre el siniestro, no una negativa a mandar nada. Lo mismo "no
fue mi culpa", "no me acuerdo la hora", "no está el otro auto".

El silencio tampoco es una negativa: si no lo mencionó, sigue pendiente. Y si
dice que lo va a conseguir o mandar después, también sigue pendiente.

Devolvé JSON:
{"declined": [{"clave": "<clave exacta>", "cita": "<sus palabras textuales>"}]}
Lista vacía si no niega ninguno.`;

  try {
    const { text } = await callGemini(
      prompt,
      "Respondé sólo con las claves de los documentos que la persona dice no tener."
    );
    if (!text) return [];

    const parsed = JSON.parse(text) as { declined?: unknown };
    if (!Array.isArray(parsed.declined)) return [];

    const normalized = normalize(said);

    return parsed.declined
      .filter(
        (d): d is { clave: string; cita: string } =>
          typeof d === "object" &&
          d !== null &&
          typeof (d as { clave?: unknown }).clave === "string" &&
          typeof (d as { cita?: unknown }).cita === "string"
      )
      // The quote has to actually be in the message. A model that cannot point
      // at the words was inferring, and inference here removes a request
      // nobody will make again.
      .filter((d) => {
        const quote = normalize(d.cita);
        return quote.length >= 4 && normalized.includes(quote);
      })
      .map((d) => d.clave.trim())
      .filter((k) => pending.includes(k));
  } catch (err) {
    console.error("[documents] decline identify failed:", errCode(err));
    return [];
  }
}

/**
 * Cerrar el pedido de un contacto que ya tenemos por el canal.
 *
 * `telefono_contacto` se siembra desde la configuración del asegurador, que
 * pide un teléfono en la ficha. Por WhatsApp ese teléfono es el remitente: lo
 * sabemos con más certeza que si la persona lo escribiera, porque es el número
 * desde el que está hablando. Aun así el pedido quedaba abierto, y un pedido
 * abierto se pregunta tarde o temprano.
 *
 * Sólo el par de contacto —teléfono y mail— y no cualquier dato pendiente. La
 * diferencia es de dónde viene el valor: el contacto es la identidad del
 * transporte, un hecho; la hora del siniestro es una lectura del texto, una
 * interpretación. Cerrar un pedido por una interpretación es marcar como
 * recibido algo que nadie confirmó, y esa es la dirección de la cautela que
 * este archivo entero respeta: un documento mal dado por recibido desaparece de
 * la lista del analista y nadie se entera hasta que el reclamo se traba.
 */
/**
 * Qué pedidos de contacto se pueden cerrar con lo que ya tenemos.
 *
 * Pura, y separada de la escritura, porque es acá donde se puede meter la
 * pata: cerrar de más es marcar como recibido algo que nadie mandó.
 */
/**
 * Los datos de contacto que el canal mismo satisface.
 *
 * Si alguien escribe por WhatsApp, su teléfono es el remitente: pedírselo es
 * de las cosas que hacen que deje de contestar. Lo mismo el correo por mail.
 *
 * Está exportado porque el pen test necesita la misma lista. Ahí las sondas
 * preguntan si un ataque logró marcar como recibido algo que nunca llegó, y
 * estos tres SÍ llegaron —por el transporte— así que contarlos daba un rojo
 * sobre comportamiento correcto. Con la lista duplicada a mano, el día que
 * alguien agregue un cuarto contacto acá el pen test vuelve a mentir.
 */
export const CONTACT_DOC_KEYS = ["phone", "telefono_contacto", "email"] as const;

export function contactDocsToClose(
  fields: Array<{ field_key: string; field_value?: string | null }>
): string[] {
  const held = new Set(
    fields
      .filter((f) => (f.field_value ?? "").trim().length > 0)
      .map((f) => canonicalFieldKey(f.field_key))
  );

  return [...CONTACT_DOC_KEYS].filter((key) => held.has(canonicalFieldKey(key)));
}

export async function satisfyContactDocsWeAlreadyHave(
  caseId: string,
  tenantId: string,
  fields: Array<{ field_key: string; field_value?: string | null }>
): Promise<void> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const closable = contactDocsToClose(fields);
  if (closable.length === 0) return;

  try {
    await enTenant(tenantCtx, (db) =>
      db
        .update(missingDocs)
        .set({ satisfied_at: new Date().toISOString() })
        .where(
          and(
            eq(missingDocs.case_id, caseId),
            isNull(missingDocs.satisfied_at),
            isNull(missingDocs.declined_at),
            inArray(missingDocs.doc_key, closable)
          )
        )
    );
  } catch (err) {
    // Que no se cierre no rompe nada: se vuelve a preguntar, que es la falla
    // barata. Lo caro es lo contrario.
    console.error("[documents] contact close failed:", errCode(err), "case:", caseId);
  }
}
