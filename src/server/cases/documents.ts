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
import { claimAttachments, missingDocs, requiredDocsConfig } from "@/lib/db/schema";
import { callGemini } from "@/server/ai/gemini-extractor";
import { labelForField } from "@/lib/labels/claim-fields";
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
  if (!claimType) return;

  try {
    const configured = await db
      .select({ doc_key: requiredDocsConfig.doc_key })
      .from(requiredDocsConfig)
      .where(eq(requiredDocsConfig.claim_type, claimType));

    if (configured.length === 0) return;

    const existing = await db
      .select({ doc_key: missingDocs.doc_key })
      .from(missingDocs)
      .where(and(eq(missingDocs.case_id, caseId), eq(missingDocs.tenant_id, tenantId)));

    const known = new Set(existing.map((r) => r.doc_key));
    const fresh = configured.map((c) => c.doc_key).filter((k) => !known.has(k));
    if (fresh.length === 0) return;

    await db.insert(missingDocs).values(
      fresh.map((doc_key) => ({
        case_id: caseId,
        tenant_id: tenantId,
        doc_key,
        satisfied_at: null,
      }))
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
  try {
    const rows = await db
      .select({ doc_key: missingDocs.doc_key })
      .from(missingDocs)
      .where(
        and(
          eq(missingDocs.case_id, caseId),
          eq(missingDocs.tenant_id, tenantId),
          isNull(missingDocs.satisfied_at)
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
  try {
    const pending = await pendingDocKeys(caseId, tenantId);
    if (pending.length === 0) return;

    const attachments = await unmatchedAttachments(caseId, tenantId);
    if (attachments.length === 0) return;

    const satisfied = new Set<string>();

    for (const attachment of attachments) {
      const remaining = pending.filter((k) => !satisfied.has(k));
      if (remaining.length === 0) break;

      const key = await identifyDocument(attachment, remaining, claimTypeLabel);
      if (key) satisfied.add(key);
    }

    if (satisfied.size === 0) return;

    await db
      .update(missingDocs)
      .set({ satisfied_at: new Date().toISOString() })
      .where(
        and(
          eq(missingDocs.case_id, caseId),
          eq(missingDocs.tenant_id, tenantId),
          isNull(missingDocs.satisfied_at),
          inArray(missingDocs.doc_key, [...satisfied])
        )
      );

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
  const rows = await db
    .select({
      id: claimAttachments.id,
      filename: claimAttachments.file_name,
      contentType: claimAttachments.content_type,
      storagePath: claimAttachments.storage_path,
    })
    .from(claimAttachments)
    .where(
      and(eq(claimAttachments.case_id, caseId), eq(claimAttachments.tenant_id, tenantId))
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
