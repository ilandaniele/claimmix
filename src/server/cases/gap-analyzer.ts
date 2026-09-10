/**
 * Email claim gap analyzer — determines which fields are missing, which need
 * confirmation, and the overall completeness status of an email-sourced case.
 *
 * Distinct from the legacy gap-analysis.ts (which serves the simulate flow).
 * This module is specifically designed for the email-intake pipeline and
 * operates against the claim_field_confirmations + missing_docs tables.
 *
 * AC7:  Medium-confidence fields appear in fieldsNeedingConfirmation.
 * AC9:  Conflict rows appear in fieldsNeedingConfirmation with conflictValue.
 * AC10: Missing required fields drive 'info_faltante' status.
 *
 * Required fields for a complete email claim:
 *   full_name, email OR phone, accident_date, accident_description, claim_type
 *
 * This is a pure-function-like module (DB reads only, no DB writes).
 * The orchestrator (confirmations/orchestrate.ts) calls this to decide
 * what status transitions and emails to trigger.
 */

import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  enTenant,
  enTenantVarias,
  type ClienteDatos,
  type TenantContext,
} from "@/data/scope";
import {
  claimFieldConfirmations,
  extractedFields as extractedFieldsTable,
  missingDocs,
} from "@/lib/db/schema";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";
import { canonicalFieldKey } from "@/lib/labels/claim-fields";
import { logger } from "@/lib/observability/logger";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Fields that MUST be present for an email claim to be considered complete.
 * Note: 'email' and 'phone' are treated as a contact pair — at least one required.
 */
export const REQUIRED_CLAIM_FIELDS = [
  "full_name",
  "accident_date",
  "accident_description",
  "claim_type",
  // A claim an insurer cannot attach to a policy is not a claim it can act on.
  // These were absent from the list, so nothing ever asked for them and a case
  // could reach listo_para_core with no way to identify the policyholder,
  // while the agent spent its one question confirming an inferred province.
  "policy_number",
  "dni",
] as const;

/** At least one of these contact fields must be present. */
export const REQUIRED_CONTACT_FIELDS = ["email", "phone"] as const;

/** Confidence threshold for 'medium' confidence (IC9). */
const MEDIUM_CONFIDENCE_LOW = 0.60;
/**
 * At or above this, a field is certain enough to act on without asking.
 *
 * Exported so the orchestrator resolves pending confirmations against the same
 * number that created them — two copies of this constant drifting apart would
 * mean asking about a field we already consider settled.
 */
export const MEDIUM_CONFIDENCE_HIGH = 0.85;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FieldNeedingConfirmation {
  fieldName: string;
  suggestedValue: string;
  conflictValue?: string;
  reason: "low_confidence" | "conflict" | "medium_confidence";
}

export interface GapAnalysisResult {
  /** Required fields not yet extracted at sufficient confidence. */
  missingRequiredFields: string[];
  /** Fields that need analyst confirmation before proceeding. */
  fieldsNeedingConfirmation: FieldNeedingConfirmation[];
  /** Whether all required fields are present and all confirmations resolved. */
  isComplete: boolean;
  /**
   * Overall status determination:
   *   'listo_para_core'       — all required fields + no pending confirmations
   *   'info_faltante'         — one or more required fields missing
   *   'confirmacion_pendiente'— required fields present but pending confirmations
   */
  status: "listo_para_core" | "info_faltante" | "confirmacion_pendiente";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze the gap status of an email claim.
 *
 * Reads:
 *   - missing_docs table (unresolved gaps from extraction worker)
 *   - claim_field_confirmations table (pending/conflict confirmations)
 *   - extractedFields param (the current extraction result for this run)
 *
 * Does NOT write to the DB — the orchestrator handles all writes.
 *
 * @param caseId         - UUID of the case being analyzed.
 * @param extractedFields - Fields extracted in this run (from ExtractedClaimSchema.fields).
 * @param tenantId       - UUID of the tenant (explicit tenant scoping — RLS is gone).
 */
export async function analyzeEmailClaimGaps(
  caseId: string,
  extractedFields: ExtractedField[],
  tenantId: string
): Promise<GapAnalysisResult> {
  // ── 1. Fetch unresolved missing_docs rows ──────────────────────────────────
  const { storedFields, missingDocKeys, confirmaciones } = await leerElCaso(
    caseId,
    tenantId
  );

  // Everything the case already holds, not just what this run returned.
  //
  // A re-extraction reports what it found in the message it was given. The
  // third message of a conversation was "fue un choque", and the extractor
  // returned the claim type and little else — correctly, that is what the
  // message said. Judging completeness from that one array declared the name,
  // the date, the description, the policy number and the DNI all missing, and
  // emailed the claimant asking for five things they had already sent, four of
  // which were sitting in extracted_fields at 0.95.
  //
  // Completeness is a property of the case, not of the last thing said.
  // `storedFields` sale del mismo viaje: es todo lo que el caso ya tiene, no
  // sólo lo que esta corrida devolvió. La completitud es una propiedad del
  // caso, no de lo último que se dijo.

  // ── 2. Build a map of extracted field values and confidences ──────────────
  //
  // Keyed by canonical name, best copy wins. The extractor emits `numero_poliza`
  // as readily as `policy_number`, and with the policy number now required, a
  // raw-key map would report it missing while holding it under the other
  // spelling — and email the claimant asking for something they already sent.
  const fieldMap = new Map<string, ExtractedField>();
  // Stored first, this run second: a fresh reading of the same field wins ties,
  // so a correction in the latest message is not outranked by the old value.
  for (const f of [...storedFields, ...extractedFields]) {
    const key = canonicalFieldKey(f.field_key);
    const existing = fieldMap.get(key);
    if (!existing || f.confidence >= existing.confidence) {
      fieldMap.set(key, f);
    }
  }

  // ── 3. Determine missing required fields ──────────────────────────────────
  const missingRequiredFields: string[] = [];

  // Check mandatory fields
  for (const reqField of REQUIRED_CLAIM_FIELDS) {
    const extracted = fieldMap.get(reqField);
    const isMissingInDB = missingDocKeys.includes(reqField);

    if (isMissingInDB && !extracted) {
      // Still missing — no re-extraction has provided it
      missingRequiredFields.push(reqField);
    } else if (!extracted && !isMissingInDB) {
      // Not in extracted fields and not in missing_docs — add it
      missingRequiredFields.push(reqField);
    } else if (extracted && extracted.confidence < MEDIUM_CONFIDENCE_LOW) {
      // Below low confidence threshold → treat as missing (AC8, IC9)
      missingRequiredFields.push(reqField);
    }
  }

  /*
   * Hace falta AL MENOS UNO de los campos de contacto.
   *
   * Recorre `REQUIRED_CONTACT_FIELDS` en vez de escribir "email" y "phone" a
   * mano cuatro veces, que es como estaba: la constante se exportaba con el
   * comentario «al menos uno de estos tiene que estar» y no la usaba nadie, ni
   * siquiera esta comprobación. Agregarle un tercer canal —WhatsApp, por
   * ejemplo— no cambiaba absolutamente nada, y el que la agregara no tenía
   * forma de enterarse.
   */
  const tieneAlguno = REQUIRED_CONTACT_FIELDS.some((clave) => {
    const campo = fieldMap.get(clave);
    return campo !== undefined && campo.confidence >= MEDIUM_CONFIDENCE_LOW;
  });

  // Se pidió y no llegó, o nunca lo mencionaron: en los dos casos falta.
  const algunoPedidoYSinValor = REQUIRED_CONTACT_FIELDS.some((clave) =>
    missingDocKeys.includes(clave)
  );
  const ningunoMencionado = REQUIRED_CONTACT_FIELDS.every(
    (clave) => !fieldMap.has(clave)
  );

  if (!tieneAlguno && (algunoPedidoYSinValor || ningunoMencionado)) {
    missingRequiredFields.push("email_or_phone");
  }

  // ── 4. Fetch pending claim_field_confirmations ────────────────────────────
  const pendingConfirmations = confirmaciones.filter((c) => c.status === "pending");

  // ── 5. Build fieldsNeedingConfirmation from pending rows ──────────────────
  const fieldsNeedingConfirmation: FieldNeedingConfirmation[] = pendingConfirmations.map(
    (row) => ({
      fieldName: row.field_key,
      suggestedValue: row.proposed_value ?? "",
      conflictValue: row.conflict_with_value ?? undefined,
      reason: determineConfirmationReason(row.confidence, !!row.conflict_with_value),
    })
  );

  // ── 6. Also check current extracted fields for medium confidence ──────────
  //
  // El conjunto se arma con TODAS las filas del caso, no solo con las
  // pendientes. Estaba armado con `fieldsNeedingConfirmation`, que sale de
  // `fetchPendingConfirmations`: una fila en `confirmed` o `corrected` no
  // estaba ahi, asi que el campo entraba igual por este paso y se volvia a
  // preguntar algo que el analista ya habia resuelto.
  const yaResueltas = confirmaciones
    .filter((c) => c.status !== "pending")
    .map((c) => c.field_key);
  const existingConfirmationKeys = new Set([
    ...fieldsNeedingConfirmation.map((f) => f.fieldName),
    ...yaResueltas,
  ]);

  for (const f of extractedFields) {
    if (existingConfirmationKeys.has(f.field_key)) continue;
    if (f.confidence >= MEDIUM_CONFIDENCE_LOW && f.confidence < MEDIUM_CONFIDENCE_HIGH) {
      // Medium confidence — needs confirmation (IC9)
      fieldsNeedingConfirmation.push({
        fieldName: f.field_key,
        suggestedValue: f.field_value,
        reason: "medium_confidence",
      });
    }
  }

  // ── 7. Determine overall status ───────────────────────────────────────────
  let status: GapAnalysisResult["status"];

  if (missingRequiredFields.length > 0) {
    // Missing required fields → info_faltante takes priority
    status = "info_faltante";
  } else if (fieldsNeedingConfirmation.length > 0) {
    // All required fields present but pending confirmations
    status = "confirmacion_pendiente";
  } else {
    // All present + confirmed
    status = "listo_para_core";
  }

  const isComplete = status === "listo_para_core";

  return {
    missingRequiredFields,
    fieldsNeedingConfirmation,
    isComplete,
    status,
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Todo lo que el análisis necesita de la base, en un viaje.
 *
 * Eran CUATRO `enTenant` seguidos, o sea cuatro POST al driver HTTP de Neon,
 * cada uno esperando al anterior sin necesitarlo: ninguna de las cuatro
 * consultas usa el resultado de otra. Y esto corre en el camino de contestarle
 * al asegurado, detrás de una llamada al modelo que ya se comió buena parte del
 * presupuesto de la corrida.
 *
 * Ahora son TRES —las dos de `claim_field_confirmations` eran la misma tabla y
 * el mismo caso, partidas por `status`, así que se piden juntas y se separan
 * acá— y las tres van en un `batch()`, que es una sola transacción y una sola
 * ida y vuelta.
 *
 * ── Por qué el camino de a uno sigue existiendo ─────────────────────────────
 *
 * Porque cada lectura degrada distinto y eso importa. Que `extracted_fields`
 * vuelva vacío es el bug que el encabezado de `fetchStoredFields` describe: se
 * le pregunta al denunciante por cinco cosas que ya mandó. Con un lote, una
 * consulta que falla se lleva puestas a las tres. Si el lote no sale, se vuelve
 * al camino viejo, donde cada una cae sola y las otras dos siguen sirviendo.
 */
async function leerElCaso(
  caseId: string,
  tenantId: string
): Promise<{
  storedFields: ExtractedField[];
  missingDocKeys: string[];
  confirmaciones: FilaDeConfirmacion[];
}> {
  // Las consultas de acá no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const [campos, huecos, confirmaciones] = await enTenantVarias<[
      FilaDeCampo[],
      Array<{ doc_key: string }>,
      FilaDeConfirmacionCruda[],
    ]>(tenantCtx, (db) => [
      consultaCampos(db, caseId),
      consultaHuecos(db, caseId),
      consultaConfirmaciones(db, caseId),
    ]);

    return {
      storedFields: deCampos(campos),
      missingDocKeys: deHuecos(huecos),
      confirmaciones: deConfirmaciones(confirmaciones),
    };
  } catch (err) {
    logger.error({
        code: codigoDeError(err),
        nota: "Se vuelve al camino de a uno, donde cada lectura degrada sola.",
      }, "gap_analyzer.lote_fallo");

    const [storedFields, missingDocKeys, confirmaciones] = await Promise.all([
      fetchStoredFields(caseId, tenantId),
      fetchMissingDocKeys(caseId, tenantId),
      fetchConfirmaciones(caseId, tenantId),
    ]);
    return { storedFields, missingDocKeys, confirmaciones };
  }
}

function codigoDeError(err: unknown): string {
  return (
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.name : "UnknownError")
  );
}

interface FilaDeCampo {
  field_key: string;
  field_value: string | null;
  confidence: string | number;
}

interface FilaDeConfirmacionCruda {
  field_key: string;
  status: string | null;
  proposed_value: string | null;
  conflict_with_value: string | null;
  confidence: string | number;
}

export interface FilaDeConfirmacion {
  field_key: string;
  status: string;
  proposed_value: string | null;
  conflict_with_value: string | null;
  confidence: number;
}

const ESTADOS_QUE_IMPORTAN = ["pending", "confirmed", "corrected"];

/** La consulta sola, para poder mandarla en un lote. Ver `leerElCaso`. */
function consultaCampos(db: ClienteDatos, caseId: string) {
  return db
    .select({
      field_key: extractedFieldsTable.field_key,
      field_value: extractedFieldsTable.field_value,
      confidence: extractedFieldsTable.confidence,
    })
    .from(extractedFieldsTable)
    .where(eq(extractedFieldsTable.case_id, caseId));
}

/** La consulta sola, para poder mandarla en un lote. Ver `leerElCaso`. */
function consultaHuecos(db: ClienteDatos, caseId: string) {
  return db
    .select({ doc_key: missingDocs.doc_key })
    .from(missingDocs)
    .where(
      and(
        eq(missingDocs.case_id, caseId),
        isNull(missingDocs.satisfied_at),
        isNull(missingDocs.declined_at)
      )
    );
}

/**
 * La consulta sola, para poder mandarla en un lote. Ver `leerElCaso`.
 *
 * Los tres estados juntos: `pending` es lo que falta preguntar y
 * `confirmed`/`corrected` es lo que una persona ya cerró. Eran dos consultas a
 * la misma tabla por el mismo caso.
 *
 * Los nombres de columna en Neon son field_name / suggested_value; se renombran
 * acá para conservar la forma interna field_key / proposed_value.
 */
function consultaConfirmaciones(db: ClienteDatos, caseId: string) {
  return db
    .select({
      field_key: claimFieldConfirmations.field_name,
      status: claimFieldConfirmations.status,
      proposed_value: claimFieldConfirmations.suggested_value,
      conflict_with_value: claimFieldConfirmations.conflict_with_value,
      confidence: claimFieldConfirmations.confidence,
    })
    .from(claimFieldConfirmations)
    .where(
      and(
        eq(claimFieldConfirmations.case_id, caseId),
        inArray(claimFieldConfirmations.status, ESTADOS_QUE_IMPORTAN)
      )
    );
}

function deCampos(rows: FilaDeCampo[]): ExtractedField[] {
  return rows.map((r) => ({
    field_key: r.field_key,
    field_value: r.field_value ?? "",
    confidence: Number(r.confidence),
    source: "ai" as const,
  }));
}

/**
 * Canónico, para que un hueco de `numero_poliza` y uno de `policy_number` sean
 * el mismo hueco y no dos.
 */
function deHuecos(rows: Array<{ doc_key: string }>): string[] {
  return rows.map((row) => canonicalFieldKey(row.doc_key));
}

/** Las columnas numéricas vuelven como texto desde Drizzle. */
function deConfirmaciones(rows: FilaDeConfirmacionCruda[]): FilaDeConfirmacion[] {
  return rows.map((row) => ({
    ...row,
    status: row.status ?? "",
    confidence: Number(row.confidence),
  }));
}

/**
 * Fields already persisted for this case by earlier extractions.
 *
 * Read-only: the orchestrator owns every write. Failure degrades to "we know
 * only what this run found", which is the behaviour that caused the bug — so
 * it is logged rather than passed over in silence.
 */
async function fetchStoredFields(
  caseId: string,
  tenantId: string
): Promise<ExtractedField[]> {
  try {
    return deCampos(
      await enTenant<FilaDeCampo[]>({ tenantId }, (db) => consultaCampos(db, caseId))
    );
  } catch (err) {
    logger.error({ detalle: codigoDeError(err) }, "gap_analyzer.extracted_fields_fetch_error");
    return [];
  }
}

/**
 * Doc keys still outstanding: neither received nor declined.
 *
 * A document the claimant told us does not exist is resolved. It is not
 * satisfied — nothing arrived, and the analyst's view keeps the distinction —
 * but it is no longer a gap the agent should be chasing.
 */
async function fetchMissingDocKeys(
  caseId: string,
  tenantId: string
): Promise<string[]> {
  try {
    return deHuecos(
      await enTenant<Array<{ doc_key: string }>>({ tenantId }, (db) =>
        consultaHuecos(db, caseId)
      )
    );
  } catch (err) {
    logger.error({ detalle: codigoDeError(err) }, "gap_analyzer.missing_docs_fetch_error");
    return [];
  }
}

/**
 * Las confirmaciones del caso que todavía dicen algo: las pendientes y las que
 * una persona ya cerró.
 *
 * Vacío = se comporta como antes de que existiera el filtro por cerradas.
 * Preferible a tirar: el análisis de huecos corre en el camino de respuesta al
 * asegurado.
 */
async function fetchConfirmaciones(
  caseId: string,
  tenantId: string
): Promise<FilaDeConfirmacion[]> {
  try {
    return deConfirmaciones(
      await enTenant<FilaDeConfirmacionCruda[]>({ tenantId }, (db) =>
        consultaConfirmaciones(db, caseId)
      )
    );
  } catch (err) {
    logger.error({ detalle: codigoDeError(err) }, "gap_analyzer.claim_field_confirmations_fetch_error");
    return [];
  }
}

/**
 * Determine the reason for a confirmation row.
 *
 * If a conflict value exists → 'conflict'.
 * Otherwise, based on confidence:
 *   - below medium band → 'low_confidence'
 *   - within medium band → 'medium_confidence'
 */
function determineConfirmationReason(
  confidence: number,
  hasConflict: boolean
): FieldNeedingConfirmation["reason"] {
  if (hasConflict) return "conflict";
  if (confidence < MEDIUM_CONFIDENCE_LOW) return "low_confidence";
  return "medium_confidence";
}
