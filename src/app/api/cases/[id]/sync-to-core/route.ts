/**
 * POST /api/cases/:id/sync-to-core — trigger CoreSyncService for a ready case.
 *
 * AC17: Invokes the mock CoreSyncService.
 *       On success: cases.status='enviado_a_core', cases.core_external_id populated.
 *       On failure: cases.status='error_core', cases.core_error_message populated.
 *       Audit log: CORE_SYNC_SUCCESS or CORE_SYNC_FAILED.
 *
 * Auth: role must be 'admin' or 'specialist'.
 * Rate limit: SYNC_TO_CORE config (5/min per user).
 * Precondition: cases.status must be 'listo_para_core' (unless force=true).
 */

import { and, eq } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { db } from "@/lib/db";
import { cases, extractedFields } from "@/lib/db/schema";
import { SyncToCoreSchema } from "@/lib/schemas/cases";
import { getCoreSyncClient } from "@/server/core-sync/client";
import type { CoreSyncPayload } from "@/server/core-sync/client";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { rateLimit, RATE_LIMIT_CONFIGS, buildUserKey } from "@/lib/rate-limit/index";

const REQUIRED_STATUS = "listo_para_core";
const SUCCESS_STATUS = "enviado_a_core" as const;
const FAILURE_STATUS = "error_core" as const;

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Auth — admin or specialist only ───────────────────────────────────────
  let ctx: Awaited<ReturnType<typeof requireRole>>;
  try {
    ctx = await requireRole("admin", "specialist");
  } catch (e) {
    if (e instanceof AppError) return err(e);
    throw e;
  }
  const { userRow } = ctx;

  // ── 2. Rate limit ─────────────────────────────────────────────────────────────
  const rlKey = buildUserKey(userRow.id, "sync-to-core");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.SYNC_TO_CORE);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes. Esperá un momento."));
  }

  // ── 3. Route params ───────────────────────────────────────────────────────────
  const rawParams = await context.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return err(new AppError("NOT_FOUND", "El caso no existe."));
  }
  const { id: caseId } = parsedParams.data;

  // ── 4. Request body ───────────────────────────────────────────────────────────
  const body = await request.json().catch(() => ({}));
  const parsed = SyncToCoreSchema.safeParse(body);
  if (!parsed.success) {
    return err(new AppError("VALIDATION_FAILED", "Los datos enviados no son válidos.", parsed.error.flatten().fieldErrors));
  }
  const { force } = parsed.data;

  // ── 5. Fetch case (explicit tenant filter = IDOR protection) ─────────────────
  const [caseRow] = await db
    .select({
      id: cases.id,
      status: cases.status,
      tenant_id: cases.tenant_id,
      claim_type: cases.claim_type,
      severity: cases.severity,
      policy_number: cases.policy_number,
      policyholder_name: cases.policyholder_name,
    })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.tenant_id, userRow.tenant_id)))
    .limit(1);

  if (!caseRow) return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));

  const currentStatus = caseRow.status;
  const tenantId = caseRow.tenant_id;

  // ── 6. FSM precondition ───────────────────────────────────────────────────────
  if (!force && currentStatus !== REQUIRED_STATUS) {
    return err(new AppError("FSM_INVALID_TRANSITION", `El caso debe estar en estado '${REQUIRED_STATUS}'. Estado actual: '${currentStatus}'.`));
  }

  // ── 7. Build CoreSyncPayload ──────────────────────────────────────────────────
  const fieldRows = await db
    .select({ field_key: extractedFields.field_key, field_value: extractedFields.field_value })
    .from(extractedFields)
    .where(eq(extractedFields.case_id, caseId));

  const extractedFieldsMap: Record<string, string> = {};
  for (const row of fieldRows) extractedFieldsMap[row.field_key] = row.field_value;

  const payload: CoreSyncPayload = {
    caseId,
    tenantId,
    claimType: caseRow.claim_type ?? "unknown",
    severity: caseRow.severity ?? null,
    customerName: caseRow.policyholder_name ?? extractedFieldsMap.full_name ?? null,
    policyNumber: caseRow.policy_number ?? extractedFieldsMap.policy_number ?? null,
    accidentDate: extractedFieldsMap.accident_date ?? null,
    accidentDescription: extractedFieldsMap.accident_description ?? null,
    extractedFields: extractedFieldsMap,
  };

  // ── 8. Call CoreSyncClient ────────────────────────────────────────────────────
  const syncClient = getCoreSyncClient();
  const result = await syncClient.syncCase(payload);
  const now = new Date().toISOString();

  if (result.success) {
    await db.update(cases).set({ status: SUCCESS_STATUS, core_external_id: result.externalId, core_sent_at: now, updated_at: now }).where(eq(cases.id, caseId));

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.CORE_SYNC_SUCCESS,
      target_type: "case",
      target_id: caseId,
      payload: { case_id: caseId, core_external_id: result.externalId, from_status: currentStatus, new_status: SUCCESS_STATUS },
    });

    return ok({ synced: true, externalId: result.externalId });
  } else {
    const errorMessage = result.errorMessage ?? "Error desconocido al sincronizar.";

    await db.update(cases).set({ status: FAILURE_STATUS, core_error_message: errorMessage, updated_at: now }).where(eq(cases.id, caseId));

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.CORE_SYNC_FAILED,
      target_type: "case",
      target_id: caseId,
      payload: { case_id: caseId, error_code: "CORE_SYNC_FAILED", from_status: currentStatus, new_status: FAILURE_STATUS },
    });

    return ok({ synced: false, errorMessage });
  }
}
