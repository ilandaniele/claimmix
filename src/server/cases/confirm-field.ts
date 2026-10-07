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

import { and, eq, isNull, sql } from "drizzle-orm";

import { isValidTransition } from "@/core/case/fsm";
import { camposDelPuntaje, clavesPonderadas, puntajeDelCaso } from "@/core/case/puntaje-complejidad";
import { enTenant, enTenantVarias, type ClienteDatos, type TenantContext } from "@/data/scope";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { redactObject } from "@/lib/audit/redact";
import { firstRow } from "@/lib/db/helpers";
import {
  cases,
  claimFieldConfirmations,
  extractedFields,
  missingDocs,
} from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { canonicalFieldKey } from "@/lib/labels/claim-fields";
import type { CaseRow, UserRow } from "@/lib/db/types";
import type { CaseStatus, ConfirmField } from "@/lib/schemas/cases";
import { auditoriaSiQuedo } from "@/server/cases/auditoria-si-quedo";
import {
  ajusteDeVencimiento,
  columnasDeTrabajo,
  criteriosDeTrabajo,
  efectosDeTransicion,
  type ConfiguracionGuardada,
} from "@/server/cases/efectos-de-transicion";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";
import { updateMemoryFromConfirmation } from "@/server/memory/update";
import { mensajesEntrantes } from "@/server/cases/inbound-messages";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";

/** Quién resuelve: el id para la auditoría, el rol para saber qué le toca. */
export type ActorDeConfirmacion = Pick<UserRow, "id" | "role">;

/** El caso tal como lo lee la confirmación: lo suyo y lo que el equipo configuró. */
type CasoLeido = Pick<
  CaseRow,
  "id" | "status" | "assigned_to" | "claim_type" | "severity" | "fraud_risk_level" | "injury_severity" | "monto_estimado" | "channel"
> &
  ConfiguracionGuardada & { pesos_puntaje: unknown };

export interface FieldConfirmationResult {
  case_id: string;
  field_key: string;
  new_status: string;
  claim_memory_updated: boolean;
}

/**
 * Resuelve un campo pendiente.
 *
 * @throws AppError('VALIDATION_FAILED') si se pide confirmar algo sin valor.
 * @throws AppError('NOT_FOUND') si el caso no existe, es de otra aseguradora, o
 *   es de otro analista. Nunca 403: un 403 confirmaría que el caso existe, y
 *   eso solo ya permite enumerar los casos de la competencia.
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
  actor: ActorDeConfirmacion,
  ip: string | null = null,
  ua: string | null = null
): Promise<FieldConfirmationResult> {
  const actorId = actor.id;
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
  let caseRow: CasoLeido | null;
  try {
    caseRow = firstRow(
      await enTenant(ctx, (db) =>
        db
          .select({
            id: cases.id,
            status: cases.status,
            assigned_to: cases.assigned_to,
            claim_type: cases.claim_type,
            severity: cases.severity,
            fraud_risk_level: cases.fraud_risk_level,
            injury_severity: cases.injury_severity,
            monto_estimado: cases.monto_estimado,
            channel: cases.channel,
            ...columnasDeTrabajo,
          })
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

  /*
   * Un analista resuelve campos de los casos que tiene asignados, y nada más.
   *
   * `patchCase` ya no lo deja editar un caso ajeno y `deleteCases` no lo deja
   * borrarlo; acá no había nada, así que el mismo analista podía confirmar,
   * corregir o rechazar cualquier campo de cualquier caso del inquilino — y eso
   * escribe en `extracted_fields` Y en la memoria del cliente, que se propaga a
   * todos sus siniestros siguientes.
   *
   * 404 y no 403, por lo mismo que arriba: un 403 confirmaría que el caso
   * existe, y eso solo ya permite enumerar los casos de los demás.
   */
  if (actor.role === "analyst" && caseRow.assigned_to !== actor.id) {
    throw new AppError("NOT_FOUND", "El caso no existe o no tenés acceso.");
  }

  const currentStatus = caseRow.status as CaseStatus;
  const caso = caseRow;
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
    logger.error({ code: errorCode(e) }, "confirm_field.claim_field_confirmations_fetch_error");
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
    caso,
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
  a: ContextoAccion & { confirmedValue: string; action: "confirm" | "correct"; caso: CasoLeido }
): Promise<FieldConfirmationResult> {
  const { ctx, caseId, fieldKey, confirmedValue, action, confirmationRow, actorId, now, tenantId, ip, ua, caso } = a;

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
      logger.error({ code: errorCode(e) }, "confirm_field.confirmation_update_error");
    }
  }

  try {
    await enTenant(ctx, (db) =>
      db
        .insert(extractedFields)
        .values({
          case_id: caseId,
          tenant_id: tenantId,
          field_key: canonicalFieldKey(fieldKey),
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
    logger.error({ code: errorCode(e) }, "confirm_field.extracted_fields_upsert_error");
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
    logger.error({ code: errorCode(e) }, "confirm_field.missing_docs_update_error");
  }

  /*
   * La memoria del cliente se toca SÓLO acá, después de que una persona
   * confirmó. Nunca desde la extracción automática: si el agente se equivoca y
   * eso queda en la memoria, el error se propaga a todos los siniestros
   * siguientes de esa persona.
   */
  const senderEmail = await getSenderEmail(ctx, caseId, caso.channel);
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

  const newStatus = await reEvaluateStatus(ctx, caso, fieldKey, actorId, ip, ua);

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
      logger.error({ code: errorCode(e) }, "confirm_field.reject_update_error");
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
  caseId: string,
  channel: string
): Promise<string | null> {
  /*
   * Se lee por `mensajesEntrantes`, que mira `raw_messages` Y `claim_messages`.
   *
   * Miraba sólo `raw_messages`, y en el canal de correo REAL esa tabla puede no
   * tener ni una fila: el poller de Gmail guarda en `claim_messages`. O sea que
   * la memoria del cliente se escribía con una clave —el remitente— que en
   * producción venía siempre en null, así que no se escribía nunca. Un producto
   * que dice aprender de cada confirmación y no aprendía de ninguna, sin fallar.
   *
   * `mensajesEntrantes` ya resuelve la cascada y está probado; acá se reusa en
   * vez de duplicar la consulta, que es como se llegó a tener dos.
   */
  const [primero] = await mensajesEntrantes(ctx, caseId, {
    orden: "viejos",
    tope: 1,
    channel,
  });
  if (primero?.autenticado === false) {
    // La clave de la memoria es la dirección: si no está autenticada, lo que
    // confirmó el analista no se le atribuye a esa persona.
    logger.warn({ case_id: caseId }, "confirm_field.memoria_omitida_remitente_sin_autenticar");
    return null;
  }
  return primero?.from_addr || null;
}

/**
 * Después de cada confirmación, ¿el caso quedó completo?
 *
 * Se vuelve a correr el análisis de brechas y, si el estado que sale es
 * distinto, se transiciona — pero sólo si la máquina de estados lo permite. Sin
 * ese chequeo, una confirmación tardía podría mover un caso ya cerrado.
 *
 * El estado, su auditoría y lo que el equipo espera de ese estado (vencimiento,
 * asignación, plan) van en un solo lote. Si el lote falla —una columna que
 * falta, un efecto roto— el estado se aplica igual con el UPDATE de siempre: no
 * poder armar lo del equipo no es motivo para dejar el caso donde estaba.
 *
 * Confirmar un campo que los pesos del puntaje cuentan lo recalcula, con o sin
 * cambio de estado.
 *
 * Cualquier error devuelve el estado actual: no poder recalcular el estado no
 * es motivo para deshacer una confirmación que ya se escribió.
 */
async function reEvaluateStatus(
  ctx: TenantContext,
  caso: CasoLeido,
  fieldKey: string,
  actorId: string,
  ip: string | null,
  ua: string | null
): Promise<string> {
  const caseId = caso.id;
  const currentStatus = caso.status as CaseStatus;
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
    const puntaje = puntajeSiCambia(caso, fieldKey, fields);

    if (newStatus === currentStatus || !isValidTransition(currentStatus, newStatus)) {
      if (puntaje !== undefined) await guardarPuntaje(ctx, caseId, puntaje);
      return currentStatus;
    }

    return (await aplicarEstado(ctx, caso, newStatus, puntaje, actorId, ip, ua)) ? newStatus : currentStatus;
  } catch (e) {
    logger.error({ detalle: e instanceof Error ? e.name : "UnknownError" }, "confirm_field.reevaluatestatus_error");
    return currentStatus;
  }
}

/**
 * El puntaje nuevo, si el campo que se confirmó es de los que los pesos cuentan;
 * `undefined` si no. Los valores salen de los campos ya guardados, que incluyen
 * el que acaba de confirmar la persona.
 */
function puntajeSiCambia(
  caso: CasoLeido,
  fieldKey: string,
  fields: { field_key: string; field_value: string | null }[]
): number | undefined {
  const claves = clavesPonderadas(caso.pesos_puntaje);
  const canonica = canonicalFieldKey(fieldKey);
  if (!claves.some((k) => canonicalFieldKey(k) === canonica)) return undefined;
  return puntajeDelCaso(caso, camposDelPuntaje(caso.pesos_puntaje, fields), caso.pesos_puntaje);
}

async function guardarPuntaje(ctx: TenantContext, caseId: string, puntaje: number) {
  try {
    await enTenant(ctx, (db) => db.update(cases).set({ puntaje_complejidad: puntaje }).where(eq(cases.id, caseId)));
  } catch (e) {
    logger.error({ code: errorCode(e) }, "confirm_field.puntaje_update_error");
  }
}

/** Mueve el caso a `hacia`. Devuelve si quedó ahí: `false` si otra mano ya lo había movido o si falló. */
async function aplicarEstado(
  ctx: TenantContext,
  caso: CasoLeido,
  hacia: CaseStatus,
  puntaje: number | undefined,
  actorId: string,
  ip: string | null,
  ua: string | null
): Promise<boolean> {
  const caseId = caso.id;
  const desde = caso.status as CaseStatus;
  const criterios = criteriosDeTrabajo(caso, caso.claim_type);
  const cambiarEstado = (db: ClienteDatos, ajuste: object = {}) => {
    return db
      .update(cases)
      .set({ status: hacia, updated_at: new Date().toISOString(), ...ajuste })
      .where(and(eq(cases.id, caseId), eq(cases.status, desde)))
      .returning({ id: cases.id });
  };

  try {
    const [filas] = await enTenantVarias<[{ id: string }[]]>(ctx, (db) => [
      cambiarEstado(db, {
        ...ajusteDeVencimiento(hacia, criterios),
        ...(puntaje === undefined ? {} : { puntaje_complejidad: puntaje }),
      }),
      auditoriaSiQuedo(
        db,
        {
          caseId,
          actorId,
          eventType: AuditEvent.CASE_STATUS_CHANGED,
          payload: { from: desde, to: hacia, old_status: desde, new_status: hacia, trigger: "field_confirmation" },
          ip,
          ua,
        },
        hacia
      ),
      ...efectosDeTransicion(db, { caseId, hacia, origen: "agente", actorId: null, criterios }),
    ]);
    // El estado no pegó, así que el puntaje que iba en ese UPDATE tampoco: va aparte.
    if (filas.length === 0 && puntaje !== undefined) await guardarPuntaje(ctx, caseId, puntaje);
    return filas.length > 0;
  } catch (e) {
    logger.warn({ code: errorCode(e), case_id: caseId, status: hacia }, "confirm_field.efectos_fallaron");
  }

  try {
    const filas = await enTenant(ctx, (db) => cambiarEstado(db));
    // El respaldo no toca las columnas nuevas; el puntaje recalculado se guarda aparte, que falle por su cuenta.
    if (puntaje !== undefined) await guardarPuntaje(ctx, caseId, puntaje);
    if (filas.length === 0) return false;
  } catch (e) {
    logger.error({ code: errorCode(e) }, "confirm_field.status_update_error");
    return false;
  }

  await writeAuditLog({
    tenant_id: ctx.tenantId,
    actor_id: actorId,
    event_type: AuditEvent.CASE_STATUS_CHANGED,
    target_type: "case",
    target_id: caseId,
    payload: { from: desde, to: hacia, trigger: "field_confirmation" },
    ip,
    ua,
  });
  return true;
}
