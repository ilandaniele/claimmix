/**
 * Case patch logic — `PATCH /api/cases/:id`.
 *
 * Validates FSM transitions, enforces ownership rules, writes audit log,
 * and updates the case row.
 *
 * Ownership rules:
 * - An analyst can PATCH cases assigned to them (`assigned_to = user.id`).
 * - A supervisor or admin can PATCH any case in their tenant.
 * - A wrong-tenant request is caught by RLS (returns 404, not 403).
 *
 * AC15: Successful PATCH writes an audit_log row with old/new status.
 * AC15: Wrong-tenant PATCH returns 404 (RLS hides the row → no rows updated).
 */

 
type AnySupabaseClient = any;
import type { Database } from "@/lib/supabase/types";
import type { CasePatch } from "@/lib/schemas/cases";
import type { CaseStatus } from "@/lib/schemas/cases";
import { validateTransition } from "@/server/cases/fsm";
import { writeAuditLog, AuditEvent, type AuditEventType } from "@/lib/audit/log";
import { AppError } from "@/lib/errors";

type CaseRow = Database["public"]["Tables"]["cases"]["Row"];
type UserRow = Database["public"]["Tables"]["users"]["Row"];

export interface PatchResult {
  case: CaseRow;
}

/**
 * Patch a case with the given updates.
 *
 * @param supabase  - User-scoped Supabase client (RLS enforces tenant isolation).
 * @param caseId    - UUID of the case to update.
 * @param patch     - Validated patch payload (status, assigned_to, reason).
 * @param actor     - The authenticated user performing the update.
 * @param ip        - Client IP for audit log.
 * @param ua        - User-Agent for audit log.
 *
 * @throws AppError(NOT_FOUND)              - Case not found or wrong tenant.
 * @throws AppError(FSM_INVALID_TRANSITION) - Requested status transition is not allowed.
 * @throws AppError(FORBIDDEN_ROLE)         - Analyst cannot patch another analyst's case.
 * @throws AppError(INTERNAL_ERROR)         - Supabase update failed unexpectedly.
 */
export async function patchCase(
  supabase: AnySupabaseClient,
  caseId: string,
  patch: CasePatch,
  actor: UserRow,
  ip: string | null,
  ua: string | null
): Promise<PatchResult> {
  // ── 1. Fetch current case (RLS-scoped — wrong tenant → null) ──────────────
   
  const { data: currentData, error: fetchError } = await (supabase as any)
    .from("cases")
    .select("*")
    .eq("id", caseId)
    .single();

  if (fetchError || !currentData) {
    throw new AppError("NOT_FOUND", "El caso no existe o no tenés acceso.");
  }

  const current = currentData as CaseRow;

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
  const updateData: Record<string, unknown> = {
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

  // ── 5. Apply update (RLS ensures only tenant-matching rows are updated) ────
   
  const { data: updatedData, error: updateError } = await (supabase as any)
    .from("cases")
    .update(updateData)
    .eq("id", caseId)
    .select("*")
    .single();

  if (updateError || !updatedData) {
    // RLS may silently return 0 rows for wrong-tenant updates.
    throw new AppError("NOT_FOUND", "El caso no existe o no tenés acceso.");
  }

  const updated = updatedData as CaseRow;

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
