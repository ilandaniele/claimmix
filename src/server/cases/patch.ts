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

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { enTenant, enTenantVarias, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";
import type { CaseInsert, CaseRow, UserRow } from "@/lib/db/types";
import type { CasePatch } from "@/lib/schemas/cases";
import type { CaseStatus } from "@/lib/schemas/cases";
import { validateTransition } from "@/core/case/fsm";
import { writeAuditLog, AuditEvent, type AuditEventType } from "@/lib/audit/log";
import { puedeCambiarEstado } from "@/lib/auth/roles";
import { auditoriaSiQuedo } from "@/server/cases/auditoria-si-quedo";
import { AppError } from "@/lib/errors";

/** The actor fields patchCase actually needs (matches requireRole's userRow). */
export type PatchActor = Pick<UserRow, "id" | "tenant_id" | "role">;

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
  if (patch.status !== undefined && patch.status !== current.status) {
    const validationError = validateTransition(
      current.status as CaseStatus,
      patch.status as CaseStatus
    );
    if (validationError) {
      throw new AppError("FSM_INVALID_TRANSITION", validationError);
    }
  }

  const destino = patch.status ?? current.status;
  if (patch.confirmar_listo && destino !== "listo_para_core") {
    throw new AppError("FSM_INVALID_TRANSITION", "Sólo se confirma un caso que queda listo para Core.");
  }

  // ── 4. Build update payload ────────────────────────────────────────────────
  const updateData: Partial<CaseInsert> = {
    updated_at: new Date().toISOString(),
  };

  if (patch.status !== undefined) {
    updateData.status = patch.status;
    if (patch.status === "cerrado") {
      updateData.closed_at = new Date().toISOString();
      // Un caso cerrado no le debe respuesta a nadie.
      updateData.para_responder_desde = null;
    }
  }

  if (patch.assigned_to !== undefined) {
    updateData.assigned_to = patch.assigned_to;
  }

  // ── 5. Apply update (tenant filter ensures only tenant-matching rows) ──────
  if (patch.confirmar_listo) {
    const ahora = updateData.updated_at!;
    let filas: CaseRow[];
    try {
      [filas] = await enTenantVarias<[CaseRow[], unknown]>(tenantCtx, (db) => [
        db
          .update(cases)
          .set(updateData)
          .where(and(eq(cases.id, caseId), eq(cases.status, current.status)))
          .returning(),
        auditoriaSiQuedo(
          db,
          {
            caseId,
            actorId: actor.id,
            eventType: AuditEvent.CASE_READY_CONFIRMED,
            payload: { old_status: current.status, new_status: "listo_para_core", reason: patch.reason ?? null },
            ip,
            ua,
          },
          sql`${cases.updated_at} = ${ahora}::timestamptz and ${cases.status} = 'listo_para_core'`
        ),
      ]);
    } catch {
      filas = [];
    }

    const updated = firstRow(filas);
    if (!updated) {
      // El caso cambió (otro PATCH, o el estado ya no es el que vimos) mientras confirmábamos.
      throw new AppError("FSM_INVALID_TRANSITION", "El caso cambió mientras lo mirabas.");
    }

    return { case: updated };
  }

  let updated: CaseRow | null;
  try {
    updated = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .update(cases)
          .set(updateData)
          .where(eq(cases.id, caseId))
          .returning()
      )
    );
  } catch {
    updated = null;
  }

  if (!updated) {
    // Wrong-tenant updates match 0 rows → indistinguishable 404.
    throw new AppError("NOT_FOUND", "El caso no existe o no tenés acceso.");
  }

  // ── 6. Write audit log ────────────────────────────────────────────────────
  const auditPayload: Record<string, unknown> = {
    reason: patch.reason ?? null,
  };

  let eventType: AuditEventType = AuditEvent.CASE_STATUS_CHANGED;
  if (patch.status === "cerrado") {
    eventType = AuditEvent.CASE_CLOSED;
    auditPayload.old_status = current.status;
    auditPayload.new_status = updated.status;
  } else if (patch.status !== undefined) {
    auditPayload.old_status = current.status;
    auditPayload.new_status = updated.status;
  }

  if (patch.assigned_to !== undefined) {
    // Un cierre queda como cierre aunque reasigne: el reenvío lee `case.closed`.
    if (patch.status !== "cerrado") eventType = AuditEvent.CASE_ASSIGNED;
    auditPayload.assigned_to = patch.assigned_to;
  }

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
