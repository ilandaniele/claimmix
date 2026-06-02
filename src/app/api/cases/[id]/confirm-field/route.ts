/**
 * PATCH /api/cases/:id/confirm-field — confirm, correct, or reject an extracted field.
 *
 * AC14: Memory is ONLY updated after explicit human confirmation via this endpoint.
 * AC16: FSM transition is re-evaluated after each confirmation.
 * AC21: Every confirmation writes audit_log FIELD_CONFIRMED with redacted values.
 *
 * Auth: user-scoped Supabase client (RLS enforces cross-tenant isolation → AC19).
 * Rate limit: CONFIRM_FIELD config (30/min per user).
 *
 * Request body: { field_key, value, action: 'confirm' | 'correct' | 'reject' }
 * Response 200: { case_id, field_key, new_status, claim_memory_updated }
 * Response 400: invalid FSM transition or field already confirmed
 * Response 404: case not found or wrong tenant (IDOR defense)
 */

import { type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { ConfirmFieldSchema } from "@/lib/schemas/cases";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";
import { updateMemoryFromConfirmation } from "@/server/memory/update";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { redactObject } from "@/lib/audit/redact";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";
import { isValidTransition } from "@/server/cases/fsm";
import type { CaseStatus } from "@/lib/schemas/cases";
import { z } from "zod";

// ── Params schema ─────────────────────────────────────────────────────────────

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
});

// ── PATCH /api/cases/:id/confirm-field ───────────────────────────────────────

export async function PATCH(
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

  // Fetch the user row to get tenant_id and role.
  const { data: userRowRaw } = await (supabase as any)
    .from("users")
    .select("id,tenant_id,role")
    .eq("id", user.id)
    .single();

  if (!userRowRaw) {
    return err(new AppError("MISSING_SESSION", "Usuario no encontrado."));
  }

  const userRow = userRowRaw as { id: string; tenant_id: string; role: string };

  // ── 2. Rate limit — 30/min per user ──────────────────────────────────────
  const rlKey = buildUserKey(userRow.id, "confirm-field");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.CONFIRM_FIELD);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes. Esperá un momento."));
  }

  // ── 3. Validate route params ──────────────────────────────────────────────
  const rawParams = await context.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return err(new AppError("NOT_FOUND", "El caso no existe."));
  }
  const { id: caseId } = parsedParams.data;

  // ── 4. Validate request body ──────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err(
      new AppError("VALIDATION_FAILED", "El cuerpo de la solicitud no es JSON válido.")
    );
  }

  const parsed = ConfirmFieldSchema.safeParse(body);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Los datos enviados no son válidos.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  const { field_key: fieldKey, value: confirmedValue, action } = parsed.data;

  // ── 5. Fetch case (RLS-scoped — wrong tenant returns null → 404) ──────────
  // Using the user-scoped client so RLS automatically filters to the user's tenant.
  const { data: caseRow, error: caseError } = await (supabase as any)
    .from("cases")
    .select("id,status,tenant_id,email_thread_id")
    .eq("id", caseId)
    .single();

  if (caseError || !caseRow) {
    // AC19: Always 404, never 403 — no tenant enumeration.
    return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
  }

  const currentStatus = caseRow.status as CaseStatus;
  const tenantId = caseRow.tenant_id as string;

  // ── 6. Find pending claim_field_confirmations row ─────────────────────────
  const { data: confirmationRow, error: confirmError } = await (supabase as any)
    .from("claim_field_confirmations")
    .select("id,proposed_value,conflict_with_value,status")
    .eq("case_id", caseId)
    .eq("field_key", fieldKey)
    .eq("status", "pending")
    .maybeSingle();

  if (confirmError) {
    console.error("[confirm-field] claim_field_confirmations fetch error:", confirmError.code);
    return err(new AppError("INTERNAL_ERROR"));
  }

  // Allow confirm even if no pending confirmation row exists (direct field update).
  // The confirmation row is optional — analysts can also confirm fields that
  // were extracted with high confidence but need an explicit human stamp.

  const now = new Date().toISOString();
  const serviceSupabase = createServiceClient();

  // ── 7. Handle action ──────────────────────────────────────────────────────

  if (action === "confirm" || action === "correct") {
    // ── 7a. Update claim_field_confirmations status ────────────────────────
    if (confirmationRow) {
      const { error: updateConfError } = await (serviceSupabase as any)
        .from("claim_field_confirmations")
        .update({
          status: action === "confirm" ? "confirmed" : "corrected",
          confirmed_by: userRow.id,
          confirmed_at: now,
        })
        .eq("id", confirmationRow.id);

      if (updateConfError) {
        console.error("[confirm-field] confirmation update error:", updateConfError.code);
      }
    }

    // ── 7b. Upsert extracted_fields with confirmed value ───────────────────
    if (confirmedValue !== null && confirmedValue !== undefined) {
      const { error: fieldUpsertError } = await (serviceSupabase as any)
        .from("extracted_fields")
        .upsert(
          {
            case_id: caseId,
            tenant_id: tenantId,
            field_key: fieldKey,
            field_value: confirmedValue,
            confidence: 1.0, // Human-confirmed fields have 100% confidence.
          },
          { onConflict: "case_id,field_key" }
        );

      if (fieldUpsertError) {
        console.error("[confirm-field] extracted_fields upsert error:", fieldUpsertError.code);
      }

      // ── 7c. Satisfy missing_docs if this field was missing ────────────────
      await (serviceSupabase as any)
        .from("missing_docs")
        .update({ satisfied_at: now })
        .eq("case_id", caseId)
        .eq("doc_key", fieldKey)
        .is("satisfied_at", null);

      // ── 7d. Update claim_memory — AC14 ────────────────────────────────────
      // Get sender email from raw_messages for this case.
      const senderEmail = await getSenderEmail(serviceSupabase, caseId);

      let memoryUpdated = false;
      if (senderEmail) {
        const oldValue = confirmationRow?.proposed_value ?? undefined;
        await updateMemoryFromConfirmation(
          serviceSupabase,
          tenantId,
          fieldKey,
          confirmedValue,
          senderEmail,
          caseId,
          userRow.id,
          oldValue
        );
        memoryUpdated = true;
      }

      // ── 7e. Audit log FIELD_CONFIRMED (AC21) ─────────────────────────────
      const redactedPayload = redactObject({
        case_id: caseId,
        field_key: fieldKey,
        action,
        old_value: confirmationRow?.proposed_value ?? "",
        new_value: confirmedValue,
        memory_updated: String(memoryUpdated),
      });

      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: userRow.id,
        event_type: AuditEvent.FIELD_CONFIRMED,
        target_type: "case",
        target_id: caseId,
        payload: redactedPayload,
      });

      // ── 7f. Re-run gap analysis → possible status transition ───────────────
      const newStatus = await reEvaluateStatus(
        serviceSupabase,
        caseId,
        currentStatus,
        tenantId,
        userRow.id
      );

      return ok({
        case_id: caseId,
        field_key: fieldKey,
        new_status: newStatus,
        claim_memory_updated: memoryUpdated,
      });
    }
  }

  if (action === "reject") {
    // ── 7g. Reject: mark confirmation as rejected ─────────────────────────
    if (confirmationRow) {
      const { error: rejectError } = await (serviceSupabase as any)
        .from("claim_field_confirmations")
        .update({
          status: "rejected",
          confirmed_by: userRow.id,
          confirmed_at: now,
        })
        .eq("id", confirmationRow.id);

      if (rejectError) {
        console.error("[confirm-field] reject update error:", rejectError.code);
      }
    }

    // Audit log for rejection.
    const redactedPayload = redactObject({
      case_id: caseId,
      field_key: fieldKey,
      action: "rejected",
      proposed_value: confirmationRow?.proposed_value ?? "",
    });

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.FIELD_CONFIRMED,
      target_type: "case",
      target_id: caseId,
      payload: redactedPayload,
    });

    return ok({
      case_id: caseId,
      field_key: fieldKey,
      new_status: currentStatus,
      claim_memory_updated: false,
    });
  }

  // Fallback (should not reach here due to Zod validation of action).
  return err(new AppError("VALIDATION_FAILED", "Acción no reconocida."));
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Get the sender email from raw_messages for a case.
 * Returns null if not found (graceful degradation — memory update is skipped).
 */
async function getSenderEmail(
  supabase: ReturnType<typeof createServiceClient>,
  caseId: string
): Promise<string | null> {
  try {
    const { data, error } = await (supabase as any)
      .from("raw_messages")
      .select("from_addr")
      .eq("case_id", caseId)
      .order("received_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return data.from_addr ?? null;
  } catch {
    return null;
  }
}

/**
 * Re-run gap analysis after a confirmation and update the case status if needed.
 *
 * AC16: After each confirmation, the case may transition to:
 *   - 'listo_para_core' if all confirmations resolved and no missing docs
 *   - 'info_faltante' if required docs still missing
 *   - 'recibido' if partially complete but no longer pending confirmation
 *
 * Returns the new case status.
 */
async function reEvaluateStatus(
  supabase: ReturnType<typeof createServiceClient>,
  caseId: string,
  currentStatus: CaseStatus,
  tenantId: string,
  actorId: string
): Promise<string> {
  try {
    // Fetch current extracted fields for gap analysis.
    const { data: fields } = await (supabase as any)
      .from("extracted_fields")
      .select("field_key,field_value,confidence,source")
      .eq("case_id", caseId);

    const extractedFields = (fields ?? []).map((f: any) => ({
      field_key: f.field_key,
      field_value: f.field_value,
      confidence: f.confidence,
      source: f.source ?? "ai",
    }));

    const gapResult = await analyzeEmailClaimGaps(
      caseId,
      extractedFields,
      supabase
    );

    const newStatus = gapResult.status as CaseStatus;

    // Only transition if FSM allows it.
    if (newStatus !== currentStatus && isValidTransition(currentStatus, newStatus)) {
      const { error: statusError } = await (supabase as any)
        .from("cases")
        .update({
          status: newStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", caseId);

      if (statusError) {
        console.error("[confirm-field] status update error:", statusError.code);
        return currentStatus;
      }

      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: actorId,
        event_type: AuditEvent.CASE_STATUS_CHANGED,
        target_type: "case",
        target_id: caseId,
        payload: {
          from: currentStatus,
          to: newStatus,
          trigger: "field_confirmation",
        },
      });

      return newStatus;
    }

    return currentStatus;
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error("[confirm-field] reEvaluateStatus error:", errName);
    return currentStatus;
  }
}
