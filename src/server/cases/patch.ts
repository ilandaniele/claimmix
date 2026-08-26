/**
 * Case patch logic — `PATCH /api/cases/:id`.
 *
 * Validates FSM transitions, enforces ownership rules, writes audit log,
 * and updates the case row.
 *
 * Ownership rules:
 * - An analyst can PATCH cases assigned to them (`assigned_to = user.id`).
 * - A supervisor or admin can PATCH any case in their tenant.
 * - A wrong-tenant request is caught by the explicit tenant_id filter
 *   (returns 404, not 403).
 *
 * AC15: Successful PATCH writes an audit_log row with old/new status.
 * AC15: Wrong-tenant PATCH returns 404 (tenant filter hides the row → no rows updated).
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";
import type { CaseInsert, CaseRow, UserRow } from "@/lib/db/types";
import type { CasePatch } from "@/lib/schemas/cases";
import type { CaseStatus } from "@/lib/schemas/cases";
import { validateTransition } from "@/server/cases/fsm";
import { writeAuditLog, AuditEvent, type AuditEventType } from "@/lib/audit/log";
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
  // An analyst can only PATCH their own assigned cases.
  // Supervisors and admins can patch any case in the tenant.
  if (actor.role === "analyst" && current.assigned_to !== actor.id) {
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

  // ── 4. Build update payload ────────────────────────────────────────────────
  const updateData: Partial<CaseInsert> = {
    updated_at: new Date().toISOString(),
  };

  if (patch.status !== undefined) {
    updateData.status = patch.status;
    if (patch.status === "cerrado") {
      updateData.closed_at = new Date().toISOString();
    }
  }

  if (patch.assigned_to !== undefined) {
    updateData.assigned_to = patch.assigned_to;
  }

  // ── 5. Apply update (tenant filter ensures only tenant-matching rows) ──────
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
    eventType = AuditEvent.CASE_ASSIGNED;
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
