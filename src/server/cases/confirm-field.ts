/**
 * Un analista resuelve un campo que el agente propuso: lo confirma, lo corrige
 * o lo rechaza.
 *
 * Esto vivía adentro del route handler —trescientas líneas de negocio mezcladas
 * con la sesión, la guarda de rol y el límite de tráfico—, así que para probar
 * si rechazar deja la memoria intacta había que fabricar una petición HTTP.
 *
 * ── Por qué acá y no en `src/server/confirmations/` ─────────────────────────
 *
 * Esa carpeta es dueña de la tabla `claim_field_confirmations`: la llena
 * `orchestrate.ts` y la cierra cuando contesta el asegurado. Pero es la tubería
 * del agente: no tiene actor, ni rol, ni sesión. Lo de acá es la contraparte
 * humana, y la convención de la casa es por familia de ruta —
 * `src/server/cases/{get,list,patch,delete,documents}.ts` respaldan
 * `/api/cases/*`—. Mezclar los dos modelos de actor en la misma carpeta
 * confunde más de lo que ahorra.
 *
 * ── El orden de los SELECT es carga estructural ─────────────────────────────
 *
 * Caso → confirmación → raw_messages → extracted_fields. Los tests encadenan
 * `mockReturnValueOnce` POR POSICIÓN, y el de `rls-email` arma sólo
 * `from().where().limit()` sin `orderBy`, así que adelantar el de raw_messages
 * revienta. No es casualidad ni preferencia: si hay que reordenarlos, hay que
 * tocar los mocks a propósito.
 */

import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { isValidTransition } from "@/core/case/fsm";
import { enTenant, type TenantContext } from "@/data/scope";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { redactObject } from "@/lib/audit/redact";
import { firstRow } from "@/lib/db/helpers";
import {
  cases,
  claimFieldConfirmations,
  extractedFields,
  missingDocs,
  rawMessages,
} from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import type { CaseStatus, ConfirmField } from "@/lib/schemas/cases";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";
import { updateMemoryFromConfirmation } from "@/server/memory/update";

export interface FieldConfirmationResult {
  case_id: string;
  field_key: string;
  new_status: string;
  claim_memory_updated: boolean;
}

/** El código de un error de base, sin arrastrar datos de nadie al log. */
function dbErrCode(e: unknown): string {
  return (
    (e as { code?: string })?.code ??
    (e instanceof Error ? e.name : "UnknownError")
  );
}

/**
 * Resuelve un campo pendiente.
 *
 * @throws AppError('VALIDATION_FAILED') si se pide confirmar algo sin valor.
 * @throws AppError('NOT_FOUND') si el caso no existe o es de otra aseguradora.
 *   Nunca 403: un 403 confirmaría que el caso existe, y eso solo ya permite
 *   enumerar los casos de la competencia.
 * @throws AppError('INTERNAL_ERROR') si falla la lectura de confirmaciones.
 *
 * @param ip de quien resolvió, para el registro de auditoría. Es dato personal
 *   de un empleado de la aseguradora, y va porque el resto de las acciones
 *   sobre un caso ya lo guardan —`patchCase` lo hace— y un registro donde la
 *   mitad de las acciones tiene origen y la otra mitad no sirve poco para lo
 *   que existe: reconstruir quién tocó qué. `null` cuando no se pudo determinar.
 * @param ua el navegador, por lo mismo.
 */
export async function resolveFieldConfirmation(
  ctx: TenantContext,
  caseId: string,
  input: ConfirmField,
  actorId: string,
  ip: string | null = null,
  ua: string | null = null
): Promise<FieldConfirmationResult> {
  const { field_key: fieldKey, value: confirmedValue, action } = input;

  /*
   * Confirmar algo que no tiene valor no es una acción posible, y se resolvía
   * tarde y mal: se marcaba la fila como confirmada y DESPUÉS se contestaba que
   * había fallado. El analista veía un error sobre algo que sí se había
   * escrito, reintentaba, y la segunda vez fallaba porque la fila ya no estaba
   * pendiente.
   *
   * Va primero, antes de tocar nada. Si no hay valor propuesto, lo que
   * corresponde es rechazar, que sí funciona sin valor.
   */
  if ((action === "confirm" || action === "correct") && confirmedValue == null) {
    throw new AppError(
      "VALIDATION_FAILED",
      "No hay un valor para confirmar. Si el campo quedó vacío, corresponde rechazarlo."
    );
  }

  // ── 1. El caso ────────────────────────────────────────────────────────────
  let caseRow: { id: string; status: string } | null;
  try {
    caseRow = firstRow(
      await enTenant(ctx, (db) =>
        db
          .select({ id: cases.id, status: cases.status })
          .from(cases)
          .where(eq(cases.id, caseId))
          .limit(1)
      )
    );
  } catch {
    caseRow = null;
  }

  if (!caseRow) {
    throw new AppError("NOT_FOUND", "El caso no existe o no tenés acceso.");
  }

  const currentStatus = caseRow.status as CaseStatus;
  /*
   * El inquilino sale de la sesión, no de la fila.
   *
   * Antes se usaba `caseRow.tenant_id` para todas las escrituras. Da lo mismo
   * —la fila vino filtrada por la base con este mismo contexto—, pero que el
   * dato venga de quien pidió y no de lo que devolvió una consulta es una cosa
   * menos que razonar.
   */
  const tenantId = ctx.tenantId;

  // ── 2. La confirmación pendiente, si la hay ───────────────────────────────
  // En la base las columnas se llaman `field_name` / `suggested_value`; el
  // resto del código las conoce como `field_key` / `proposed_value`.
  let confirmationRow: {
    id: string;
    proposed_value: string | null;
    conflict_with_value: string | null;
    status: string;
  } | null;
  try {
    confirmationRow = firstRow(
      await enTenant(ctx, (db) =>
        db
          .select({
            id: claimFieldConfirmations.id,
            proposed_value: claimFieldConfirmations.suggested_value,
            conflict_with_value: claimFieldConfirmations.conflict_with_value,
            status: claimFieldConfirmations.status,
          })
          .from(claimFieldConfirmations)
          .where(
            and(
              eq(claimFieldConfirmations.case_id, caseId),
              eq(claimFieldConfirmations.field_name, fieldKey),
              eq(claimFieldConfirmations.status, "pending")
            )
          )
          .limit(1)
      )
    );
  } catch (e) {
    console.error("[confirm-field] claim_field_confirmations fetch error:", dbErrCode(e));
    throw new AppError("INTERNAL_ERROR");
  }

  /*
   * La fila es opcional a propósito: un analista también puede estampar un
   * campo que el agente extrajo con confianza alta y que por eso nunca generó
   * una confirmación pendiente.
   */

  const now = new Date().toISOString();

  if (action === "reject") {
    return rechazar({
      ctx, caseId, fieldKey, confirmationRow, actorId, now, tenantId, currentStatus, ip, ua,
    });
  }

  return confirmar({
    ctx,
    caseId,
    fieldKey,
    // El guardia de arriba ya descartó el nulo; esto es para el compilador.
    confirmedValue: confirmedValue as string,
    action,
    confirmationRow,
    actorId,
    now,
    tenantId,
    currentStatus,
    ip,
    ua,
  });
}

interface ContextoAccion {
  ctx: TenantContext;
  caseId: string;
  fieldKey: string;
  confirmationRow: { id: string; proposed_value: string | null } | null;
  actorId: string;
  now: string;
  tenantId: string;
  currentStatus: CaseStatus;
  ip: string | null;
  ua: string | null;
}

/**
 * Confirmar o corregir: se estampa el valor y se vuelve a mirar si el caso
 * quedó completo.
 *
 * Los errores de escritura se registran y se sigue. Es deliberado: si falla el
 * cierre de un documento faltante, cortar dejaría el campo confirmado en una
 * tabla y no en la otra, que es peor que seguir y que el análisis de brechas lo
 * vuelva a marcar.
 */
async function confirmar(
  a: ContextoAccion & { confirmedValue: string; action: "confirm" | "correct" }
): Promise<FieldConfirmationResult> {
  const { ctx, caseId, fieldKey, confirmedValue, action, confirmationRow, actorId, now, tenantId, currentStatus, ip, ua } = a;

  if (confirmationRow) {
    try {
      await enTenant(ctx, (db) =>
        db
          .update(claimFieldConfirmations)
          .set({
            status: action === "confirm" ? "confirmed" : "corrected",
            confirmed_by: actorId,
            confirmed_at: now,
          })
          .where(eq(claimFieldConfirmations.id, confirmationRow.id))
      );
    } catch (e) {
      console.error("[confirm-field] confirmation update error:", dbErrCode(e));
    }
  }

  try {
    await enTenant(ctx, (db) =>
      db
        .insert(extractedFields)
        .values({
          case_id: caseId,
          tenant_id: tenantId,
          field_key: fieldKey,
          field_value: confirmedValue,
          confidence: "1.00", // Lo confirmó una persona: no hay incertidumbre.
        })
        .onConflictDoUpdate({
          target: [extractedFields.case_id, extractedFields.field_key],
          set: {
            field_value: sql`excluded.field_value`,
            confidence: sql`excluded.confidence`,
          },
        })
    );
  } catch (e) {
    console.error("[confirm-field] extracted_fields upsert error:", dbErrCode(e));
  }

  try {
    await enTenant(ctx, (db) =>
      db
        .update(missingDocs)
        .set({ satisfied_at: now })
        .where(
          and(
            eq(missingDocs.case_id, caseId),
            eq(missingDocs.doc_key, fieldKey),
            isNull(missingDocs.satisfied_at)
          )
        )
    );
  } catch (e) {
    console.error("[confirm-field] missing_docs update error:", dbErrCode(e));
  }

  /*
   * La memoria del cliente se toca SÓLO acá, después de que una persona
   * confirmó. Nunca desde la extracción automática: si el agente se equivoca y
   * eso queda en la memoria, el error se propaga a todos los siniestros
   * siguientes de esa persona.
   */
  const senderEmail = await getSenderEmail(ctx, caseId);
  let memoryUpdated = false;
  if (senderEmail) {
    await updateMemoryFromConfirmation(
      tenantId,
      fieldKey,
      confirmedValue,
      senderEmail,
      caseId,
      actorId,
      confirmationRow?.proposed_value ?? undefined
    );
    memoryUpdated = true;
  }

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: actorId,
    event_type: AuditEvent.FIELD_CONFIRMED,
    target_type: "case",
    target_id: caseId,
    payload: redactObject({
      case_id: caseId,
      field_key: fieldKey,
      action,
      old_value: confirmationRow?.proposed_value ?? "",
      new_value: confirmedValue,
      memory_updated: String(memoryUpdated),
    }),
    ip,
    ua,
  });

  const newStatus = await reEvaluateStatus(ctx, caseId, currentStatus, actorId, ip, ua);

  return {
    case_id: caseId,
    field_key: fieldKey,
    new_status: newStatus,
    claim_memory_updated: memoryUpdated,
  };
}

/**
 * Rechazar: se marca la fila y se registra, y nada más.
 *
 * No toca `extracted_fields`, ni los documentos faltantes, ni la memoria, ni
 * vuelve a evaluar el estado. Rechazar es decir «esto que leíste no sirve»: no
 * agrega información, así que no puede completar nada.
 */
async function rechazar(a: ContextoAccion): Promise<FieldConfirmationResult> {
  const { ctx, caseId, fieldKey, confirmationRow, actorId, now, tenantId, currentStatus, ip, ua } = a;

  if (confirmationRow) {
    try {
      await enTenant(ctx, (db) =>
        db
          .update(claimFieldConfirmations)
          .set({ status: "rejected", confirmed_by: actorId, confirmed_at: now })
          .where(eq(claimFieldConfirmations.id, confirmationRow.id))
      );
    } catch (e) {
      console.error("[confirm-field] reject update error:", dbErrCode(e));
    }
  }

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: actorId,
    event_type: AuditEvent.FIELD_CONFIRMED,
    target_type: "case",
    target_id: caseId,
    payload: redactObject({
      case_id: caseId,
      field_key: fieldKey,
      action: "rejected",
      proposed_value: confirmationRow?.proposed_value ?? "",
    }),
    ip,
    ua,
  });

  return {
    case_id: caseId,
    field_key: fieldKey,
    new_status: currentStatus,
    claim_memory_updated: false,
  };
}

/**
 * El correo de quien mandó el siniestro, que es la clave de la memoria.
 *
 * Sin remitente no se actualiza la memoria y se sigue igual: es preferible
 * perder el aprendizaje de un caso a fallar una confirmación que el analista ya
 * hizo.
 */
async function getSenderEmail(
  ctx: TenantContext,
  caseId: string
): Promise<string | null> {
  try {
    const row = firstRow(
      await enTenant(ctx, (db) =>
        db
          .select({ from_addr: rawMessages.from_addr })
          .from(rawMessages)
          .where(eq(rawMessages.case_id, caseId))
          .orderBy(asc(rawMessages.received_at))
          .limit(1)
      )
    );
    return row?.from_addr ?? null;
  } catch {
    return null;
  }
}

/**
 * Después de cada confirmación, ¿el caso quedó completo?
 *
 * Se vuelve a correr el análisis de brechas y, si el estado que sale es
 * distinto, se transiciona — pero sólo si la máquina de estados lo permite. Sin
 * ese chequeo, una confirmación tardía podría mover un caso ya cerrado.
 *
 * Cualquier error devuelve el estado actual: no poder recalcular el estado no
 * es motivo para deshacer una confirmación que ya se escribió.
 */
async function reEvaluateStatus(
  ctx: TenantContext,
  caseId: string,
  currentStatus: CaseStatus,
  actorId: string,
  ip: string | null,
  ua: string | null
): Promise<string> {
  try {
    const fields = await enTenant(ctx, (db) =>
      db
        .select({
          field_key: extractedFields.field_key,
          field_value: extractedFields.field_value,
          confidence: extractedFields.confidence,
        })
        .from(extractedFields)
        .where(eq(extractedFields.case_id, caseId))
    );

    // `confidence` es numeric y drizzle lo entrega como texto. La base no tiene
    // columna `source`: todo lo que hay acá lo extrajo el agente.
    const currentFields = fields.map((f) => ({
      field_key: f.field_key,
      field_value: f.field_value,
      confidence: Number(f.confidence),
      source: "ai" as const,
    }));

    const gapResult = await analyzeEmailClaimGaps(caseId, currentFields, ctx.tenantId);
    const newStatus = gapResult.status as CaseStatus;

    if (newStatus === currentStatus || !isValidTransition(currentStatus, newStatus)) {
      return currentStatus;
    }

    try {
      await enTenant(ctx, (db) =>
        db
          .update(cases)
          .set({ status: newStatus, updated_at: new Date().toISOString() })
          .where(eq(cases.id, caseId))
      );
    } catch (e) {
      console.error("[confirm-field] status update error:", dbErrCode(e));
      return currentStatus;
    }

    await writeAuditLog({
      tenant_id: ctx.tenantId,
      actor_id: actorId,
      event_type: AuditEvent.CASE_STATUS_CHANGED,
      target_type: "case",
      target_id: caseId,
      payload: { from: currentStatus, to: newStatus, trigger: "field_confirmation" },
      ip,
      ua,
    });

    return newStatus;
  } catch (e) {
    console.error(
      "[confirm-field] reEvaluateStatus error:",
      e instanceof Error ? e.name : "UnknownError"
    );
    return currentStatus;
  }
}
