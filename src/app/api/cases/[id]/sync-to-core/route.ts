/**
 * POST /api/cases/:id/sync-to-core — trigger CoreSyncService for a ready case.
 *
 * AC17: Invokes the mock CoreSyncService.
 *       On success: cases.status='enviado_a_core', cases.core_external_id populated.
 *       On failure: cases.status='error_core', cases.core_error_message populated.
 *       Audit log: CORE_SYNC_SUCCESS or CORE_SYNC_FAILED.
 *
 * Auth: user-scoped Supabase client. Role must be 'admin' or 'specialist'.
 * Rate limit: SYNC_TO_CORE config (5/min per user).
 * Precondition: cases.status must be 'listo_para_core' (unless force=true).
 *
 * Request body: { force?: boolean }
 * Response 200: { synced, externalId?, errorMessage? }
 * Response 400: invalid FSM state (INVALID_FSM_TRANSITION)
 * Response 403: insufficient role
 * Response 404: case not found or wrong tenant
 */

import { type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { SyncToCoreSchema } from "@/lib/schemas/cases";
import { getCoreSyncClient } from "@/server/core-sync/client";
import type { CoreSyncPayload } from "@/server/core-sync/client";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";
import { z } from "zod";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Roles allowed to trigger core sync. */
const ALLOWED_ROLES = ["admin", "specialist"] as const;

/** Required case status to trigger sync (unless force=true). */
const REQUIRED_STATUS = "listo_para_core";

/** Status set on successful sync. */
const SUCCESS_STATUS = "enviado_a_core";

/** Status set on failed sync. */
const FAILURE_STATUS = "error_core";

// ── Params schema ─────────────────────────────────────────────────────────────

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
});

// ── POST /api/cases/:id/sync-to-core ─────────────────────────────────────────

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Auth — user-scoped client (RLS enforces tenant isolation) ──────────
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }

  // Fetch the user row to verify role.
  const { data: userRowRaw } = await (supabase as any)
    .from("users")
    .select("id,tenant_id,role")
    .eq("id", user.id)
    .single();

  if (!userRowRaw) {
    return err(new AppError("MISSING_SESSION", "Usuario no encontrado."));
  }

  const userRow = userRowRaw as { id: string; tenant_id: string; role: string };

  // ── 2. Role check — admin or specialist only ──────────────────────────────
  if (!(ALLOWED_ROLES as readonly string[]).includes(userRow.role)) {
    return err(
      new AppError(
        "FORBIDDEN_ROLE",
        "Solo administradores o especialistas pueden enviar casos al sistema central."
      )
    );
  }

  // ── 3. Rate limit — 5/min per user ───────────────────────────────────────
  const rlKey = buildUserKey(userRow.id, "sync-to-core");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.SYNC_TO_CORE);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes. Esperá un momento."));
  }

  // ── 4. Validate route params ──────────────────────────────────────────────
  const rawParams = await context.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return err(new AppError("NOT_FOUND", "El caso no existe."));
  }
  const { id: caseId } = parsedParams.data;

  // ── 5. Validate request body ──────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json().catch(() => ({}));
  } catch {
    body = {};
  }

  const parsed = SyncToCoreSchema.safeParse(body);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Los datos enviados no son válidos.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  const { force } = parsed.data;

  // ── 6. Fetch case (RLS-scoped) ────────────────────────────────────────────
  const { data: caseRow, error: caseError } = await (supabase as any)
    .from("cases")
    .select(
      "id,status,tenant_id,claim_type,severity,policy_number,policyholder_name,customer_id,policy_id"
    )
    .eq("id", caseId)
    .single();

  if (caseError || !caseRow) {
    // AC19: Always 404, never 403 — no tenant enumeration.
    return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
  }

  const currentStatus = caseRow.status as string;
  const tenantId = caseRow.tenant_id as string;

  // ── 7. Status precondition check (unless force=true) ─────────────────────
  if (!force && currentStatus !== REQUIRED_STATUS) {
    return err(
      new AppError(
        "FSM_INVALID_TRANSITION",
        `El caso debe estar en estado '${REQUIRED_STATUS}' para enviarlo al sistema central. Estado actual: '${currentStatus}'.`
      )
    );
  }

  // ── 8. Build CoreSyncPayload from case + extracted_fields ─────────────────
  const serviceSupabase = createServiceClient();

  const { data: fieldRows } = await (serviceSupabase as any)
    .from("extracted_fields")
    .select("field_key,field_value")
    .eq("case_id", caseId);

  const extractedFields: Record<string, string> = {};
  for (const row of (fieldRows ?? []) as Array<{
    field_key: string;
    field_value: string;
  }>) {
    extractedFields[row.field_key] = row.field_value;
  }

  const payload: CoreSyncPayload = {
    caseId,
    tenantId,
    claimType: caseRow.claim_type ?? "unknown",
    severity: caseRow.severity ?? null,
    customerName: caseRow.policyholder_name ?? extractedFields.full_name ?? null,
    policyNumber: caseRow.policy_number ?? extractedFields.policy_number ?? null,
    accidentDate: extractedFields.accident_date ?? null,
    accidentDescription: extractedFields.accident_description ?? null,
    extractedFields,
  };

  // ── 9. Call CoreSyncClient ────────────────────────────────────────────────
  const syncClient = getCoreSyncClient();
  const result = await syncClient.syncCase(payload);

  const now = new Date().toISOString();

  if (result.success) {
    // ── 10a. Success: status='enviado_a_core', core_external_id set ──────────
    const { error: updateError } = await (serviceSupabase as any)
      .from("cases")
      .update({
        status: SUCCESS_STATUS,
        core_external_id: result.externalId,
        core_sent_at: now,
        updated_at: now,
      })
      .eq("id", caseId);

    if (updateError) {
      console.error("[sync-to-core] case update error (success path):", updateError.code);
    }

    // AC17: Audit log CORE_SYNC_SUCCESS.
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.CORE_SYNC_SUCCESS,
      target_type: "case",
      target_id: caseId,
      payload: {
        case_id: caseId,
        core_external_id: result.externalId,
        from_status: currentStatus,
        new_status: SUCCESS_STATUS,
      },
    });

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "sync_to_core.success",
        case_id: caseId,
        external_id: result.externalId,
      })
    );

    return ok({
      synced: true,
      externalId: result.externalId,
    });
  } else {
    // ── 10b. Failure: status='error_core', core_error_message set ────────────
    const errorMessage = result.errorMessage ?? "Error desconocido al sincronizar.";

    const { error: updateError } = await (serviceSupabase as any)
      .from("cases")
      .update({
        status: FAILURE_STATUS,
        core_error_message: errorMessage,
        updated_at: now,
      })
      .eq("id", caseId);

    if (updateError) {
      console.error("[sync-to-core] case update error (failure path):", updateError.code);
    }

    // AC17: Audit log CORE_SYNC_FAILED.
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.CORE_SYNC_FAILED,
      target_type: "case",
      target_id: caseId,
      payload: {
        case_id: caseId,
        error_code: "CORE_SYNC_FAILED",
        from_status: currentStatus,
        new_status: FAILURE_STATUS,
      },
    });

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "sync_to_core.failed",
        case_id: caseId,
        error_code: "CORE_SYNC_FAILED",
      })
    );

    return ok({
      synced: false,
      errorMessage,
    });
  }
}
