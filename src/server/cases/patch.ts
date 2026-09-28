/**
 * Case patch logic — `PATCH /api/cases/:id`.
 *
 * Validates FSM transitions, enforces ownership rules, writes audit log,
 * and updates the case row.
 *
 * Ownership rules: ver `puedeCambiarEstado` (owner/admin/specialist siempre,
 * analyst sólo si el caso es suyo, viewer nunca).
 * - A wrong-tenant request is caught by the explicit tenant_id filter
 *   (returns 404, not 403).
 *
 * AC15: Successful PATCH writes an audit_log row with old/new status.
 * AC15: Wrong-tenant PATCH returns 404 (tenant filter hides the row → no rows updated).
 */

import { and, eq } from "drizzle-orm";
import { enTenant, enTenantVarias, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";
import type { CaseInsert, CaseRow, UserRow } from "@/lib/db/types";
import type { CasePatch } from "@/lib/schemas/cases";
import type { CaseStatus } from "@/lib/schemas/cases";
import { validateTransition, DEVOLUCION_AL_AGENTE, ESTADOS_CERRADOS, esSalidaAMano } from "@/core/case/fsm";
import { reservaViva } from "@/core/case/reserva-de-extraccion";
import { esPlanPro } from "@/core/billing/plan-pro";
import { writeAuditLog, AuditEvent, type AuditEventType } from "@/lib/audit/log";
import { puedeCambiarEstado } from "@/lib/auth/roles";
import { auditoriaSiQuedo } from "@/server/cases/auditoria-si-quedo";
import { consultaDelUltimoMovimiento, esDevolvible, MOTIVO_DEVOLVER } from "@/server/cases/devolver-al-agente";
import { AppError } from "@/lib/errors";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";

/** The actor fields patchCase actually needs (matches requireRole's userRow). */
export type PatchActor = Pick<UserRow, "id" | "tenant_id" | "role"> & { plan: string | null };

export interface PatchResult {
  case: CaseRow;
}

/**
 * Patch a case with the given updates.
 *
 * @param caseId    - UUID of the case to update.
 * @param patch     - Validated patch payload (status, assigned_to, reason).
 * @param actor     - The authenticated user performing the update
 *                    (actor.tenant_id is the explicit tenant boundary).
 * @param ip        - Client IP for audit log.
 * @param ua        - User-Agent for audit log.
 *
 * @throws AppError(NOT_FOUND)              - Case not found or wrong tenant.
 * @throws AppError(FSM_INVALID_TRANSITION) - Requested status transition is not allowed.
 * @throws AppError(FORBIDDEN_ROLE)         - Analyst cannot patch another analyst's case.
 */
export async function patchCase(
  caseId: string,
  patch: CasePatch,
  actor: PatchActor,
  ip: string | null,
  ua: string | null
): Promise<PatchResult> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId: actor.tenant_id };
  // ── 1. Fetch current case (tenant-scoped — wrong tenant → null) ───────────
  let current: CaseRow | null;
  try {
    current = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select()
          .from(cases)
          .where(eq(cases.id, caseId))
          .limit(1)
      )
    );
  } catch {
    current = null;
  }

  if (!current) {
    throw new AppError("NOT_FOUND", "El caso no existe o no tenés acceso.");
  }

  // ── 2. Ownership check ─────────────────────────────────────────────────────
  if (!puedeCambiarEstado(actor, current.assigned_to)) {
    // Return 404 rather than 403 — consistent with IDOR prevention policy.
    // An analyst probing for cases they don't own gets the same 404 response.
    throw new AppError("NOT_FOUND", "El caso no existe o no tenés acceso.");
  }

  // ── 3. FSM transition check ────────────────────────────────────────────────
  // `enviado_a_core` y `error_core` los pone sólo el envío a Core (LLM08,
  // comentario de `fsm.ts:26`), nunca este PATCH.
  if (patch.status === "enviado_a_core" || patch.status === "error_core") {
    throw new AppError("FSM_INVALID_TRANSITION", "Ese estado lo pone sólo el envío a Core.");
  }

  // D-F2: «tomar el control» sólo con el agente terminado del todo. La UI ya
  // esconde el botón, pero la guarda de verdad es ésta.
  if (
    patch.status === "requiere_especialista" &&
    (current.extraction_pending || reservaViva(current.extraction_lease_at, new Date()))
  ) {
    throw new AppError("FSM_INVALID_TRANSITION", "El agente está trabajando en este caso.");
  }

  // E24: «Devolver al agente», el espejo de «Tomar el control» — mismo PATCH,
  // discriminado por `reason`. Va antes del chequeo genérico de FSM porque
  // `requiere_especialista → info_faltante` es una arista humana, Pro, que
  // nunca se agrega a `FSM_TRANSITIONS` (como `REAPERTURA_POR_ABANDONO`).
  if (patch.reason === MOTIVO_DEVOLVER) {
    if (patch.status !== DEVOLUCION_AL_AGENTE.hacia || current.status !== DEVOLUCION_AL_AGENTE.desde) {
      throw new AppError(
        "FSM_INVALID_TRANSITION",
        "Devolver al agente sólo va de requiere_especialista a info_faltante."
      );
    }
    if (current.channel !== "whatsapp" && current.channel !== "whatsapp_sim") {
      throw new AppError("FSM_INVALID_TRANSITION", "Devolver al agente es sólo para WhatsApp.");
    }
    if (!esPlanPro(actor.plan)) {
      throw new AppError("PLAN_REQUERIDO");
    }
    if (current.extraction_pending || reservaViva(current.extraction_lease_at, new Date())) {
      throw new AppError("FSM_INVALID_TRANSITION", "El agente está trabajando en este caso.");
    }
    const ultimo = firstRow(await enTenant(tenantCtx, (db) => consultaDelUltimoMovimiento(db, caseId)));
    if (!esDevolvible(ultimo)) {
      throw new AppError(
        "FSM_INVALID_TRANSITION",
        "Sólo se devuelve un caso tomado con «Tomar el control»."
      );
    }
    const updated = await cambiarConAuditoria(
      tenantCtx,
      {
        caseId,
        desde: DEVOLUCION_AL_AGENTE.desde,
        hacia: DEVOLUCION_AL_AGENTE.hacia,
        set: {
          status: DEVOLUCION_AL_AGENTE.hacia,
          para_responder_desde: null,
          updated_at: new Date().toISOString(),
        },
      },
      {
        actorId: actor.id,
        eventType: AuditEvent.CASE_STATUS_CHANGED,
        payload: {
          reason: MOTIVO_DEVOLVER,
          old_status: DEVOLUCION_AL_AGENTE.desde,
          new_status: DEVOLUCION_AL_AGENTE.hacia,
        },
        ip,
        ua,
      }
    );
    return { case: updated };
  }

  const desde = current.status as CaseStatus;
  // Definido sólo si el estado cambia.
  const hacia = patch.status !== desde ? patch.status : undefined;
  // Salidas a mano (`SALIDAS_A_MANO`): la entrega a la aseguradora pasó por
  // fuera, o sigue la liquidación. Fuera del grafo como la devolución.
  const salidaAMano = hacia !== undefined && esSalidaAMano(desde, hacia);

  if (hacia !== undefined && !salidaAMano) {
    const validationError = validateTransition(desde, hacia);
    if (validationError) {
      throw new AppError("FSM_INVALID_TRANSITION", validationError);
    }
  }

  const destino = patch.status ?? desde;
  if (patch.confirmar_listo && destino !== "listo_para_core") {
    throw new AppError("FSM_INVALID_TRANSITION", "Sólo se confirma un caso que queda listo para Core.");
  }

  // ── 4. Build update payload ────────────────────────────────────────────────
  const ahora = new Date().toISOString();
  const updateData: Partial<CaseInsert> = { updated_at: ahora };

  if (patch.status !== undefined) {
    updateData.status = patch.status;
    // `pagado` y `rechazado` también son un cierre y guardan su fecha ahí; la
    // de `en_liquidacion` queda en la auditoría del cambio.
    if (ESTADOS_CERRADOS.has(patch.status)) updateData.closed_at = ahora;
    if (patch.status === "cerrado") {
      // Un caso cerrado no le debe respuesta a nadie. Pagado o rechazado sí
      // (`para-responder.ts`): marcarlos no contesta lo que escribió la persona.
      updateData.para_responder_desde = null;
    }
  }

  if (patch.assigned_to !== undefined) {
    updateData.assigned_to = patch.assigned_to;
  }

  const entregadoPorFuera =
    salidaAMano && hacia === "en_liquidacion" && (desde === "listo_para_core" || desde === "error_core");
  const auditPayload: Record<string, unknown> = {
    reason: patch.reason ?? (entregadoPorFuera ? "entregado_por_fuera" : null),
  };
  if (patch.status !== undefined || patch.confirmar_listo) {
    auditPayload.old_status = desde;
    auditPayload.new_status = destino;
  }

  let eventType: AuditEventType = patch.confirmar_listo
    ? AuditEvent.CASE_READY_CONFIRMED
    : patch.status === "cerrado"
      ? AuditEvent.CASE_CLOSED
      : AuditEvent.CASE_STATUS_CHANGED;
  if (patch.assigned_to !== undefined) {
    // Un cierre queda como cierre aunque reasigne: el reenvío lee `case.closed`.
    if (eventType === AuditEvent.CASE_STATUS_CHANGED) eventType = AuditEvent.CASE_ASSIGNED;
    auditPayload.assigned_to = patch.assigned_to;
  }

  // ── 5. Apply update (tenant filter ensures only tenant-matching rows) ──────
  if (patch.confirmar_listo || salidaAMano) {
    const updated = await cambiarConAuditoria(
      tenantCtx,
      { caseId, desde, hacia: destino, set: updateData },
      { actorId: actor.id, eventType, payload: auditPayload, ip, ua }
    );
    return { case: updated };
  }

  // Con status, el where exige además el status que vimos al leer: si cambió
  // en el medio (TOCTOU), el update no matchea ninguna fila.
  const whereUpdate =
    patch.status !== undefined
      ? and(eq(cases.id, caseId), eq(cases.status, desde))
      : eq(cases.id, caseId);

  let updated: CaseRow | null;
  try {
    updated = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .update(cases)
          .set(updateData)
          .where(whereUpdate)
          .returning()
      )
    );
  } catch (err) {
    logger.error({ code: errorCode(err) }, "patch.cambio_fallo");
    updated = null;
  }

  if (!updated) {
    if (patch.status !== undefined) {
      throw new AppError("FSM_INVALID_TRANSITION", "El caso cambió mientras lo mirabas.");
    }
    // Wrong-tenant updates match 0 rows → indistinguishable 404.
    throw new AppError("NOT_FOUND", "El caso no existe o no tenés acceso.");
  }

  // ── 6. Write audit log ────────────────────────────────────────────────────
  // Audit log write must never block the response — errors are logged internally.
  await writeAuditLog({
    tenant_id: current.tenant_id,
    actor_id: actor.id,
    event_type: eventType,
    target_type: "case",
    target_id: caseId,
    payload: auditPayload,
    ip,
    ua,
  });

  return { case: updated };
}

/**
 * El update guardado por el estado que se leyó, con la auditoría en el mismo
 * batch: si el caso cambió en el medio, no queda ni el cambio ni la fila.
 */
async function cambiarConAuditoria(
  ctx: TenantContext,
  c: { caseId: string; desde: CaseStatus; hacia: CaseStatus; set: Partial<CaseInsert> },
  auditoria: Omit<Parameters<typeof auditoriaSiQuedo>[1], "caseId">
): Promise<CaseRow> {
  let filas: CaseRow[];
  try {
    [filas] = await enTenantVarias<[CaseRow[], unknown]>(ctx, (db) => [
      db
        .update(cases)
        .set(c.set)
        .where(and(eq(cases.id, c.caseId), eq(cases.status, c.desde)))
        .returning(),
      auditoriaSiQuedo(db, { caseId: c.caseId, ...auditoria }, c.hacia),
    ]);
  } catch (err) {
    const code = errorCode(err);
    // Sin esto, un error del batch se leía como «el caso cambió» y nadie se enteraba.
    logger.error({ code }, "patch.cambio_con_auditoria_fallo");
    // 23514: la base todavía no tiene la 0035. No es «el caso cambió».
    if (code === "23514") throw new AppError("INTERNAL_ERROR");
    filas = [];
  }
  const updated = firstRow(filas);
  if (!updated) {
    throw new AppError("FSM_INVALID_TRANSITION", "El caso cambió mientras lo mirabas.");
  }
  return updated;
}
