/**
 * PATCH /api/cases/:id/confirm-field — confirm, correct, or reject an extracted field.
 *
 * AC14: Memory is ONLY updated after explicit human confirmation via this endpoint.
 * AC16: FSM transition is re-evaluated after each confirmation.
 * AC21: Every confirmation writes audit_log FIELD_CONFIRMED with redacted values.
 *
 * Auth: Better Auth session. RLS is gone — every query filters explicitly by
 * the caller's tenant_id (IDOR-safe 404 for wrong-tenant cases → AC19).
 * Rate limit: CONFIRM_FIELD config (30/min per user).
 *
 * Request body: { field_key, value, action: 'confirm' | 'correct' | 'reject' }
 * Response 200: { case_id, field_key, new_status, claim_memory_updated }
 * Response 400: invalid FSM transition or field already confirmed
 * Response 404: case not found or wrong tenant (IDOR defense)
 */

import { type NextRequest } from "next/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { requireRole, ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import {
  cases,
  claimFieldConfirmations,
  extractedFields,
  missingDocs,
  rawMessages,
} from "@/lib/db/schema";
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

/** Extract a loggable error code from a thrown DB error (PII-safe). */
function dbErrCode(e: unknown): string {
  return (
    (e as { code?: string })?.code ??
    (e instanceof Error ? e.name : "UnknownError")
  );
}

// ── PATCH /api/cases/:id/confirm-field ───────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Auth — Better Auth session + public.users row ──────────────────────
  let ctx: RoleContext;
  try {
    ctx = await requireRole(...ALL_ROLES);
  } catch {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }
  const { userRow } = ctx;

  // El contexto de inquilino, apenas se sabe de quién es la sesión. Se arma acá
  // y no en cada consulta: las de abajo ya no llevan filtro por inquilino, así
  // que este objeto es lo único que le dice a la base de quién son los datos.
  const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };

  // Viewers are read-only: they can inspect claims but never mutate them.
  if (userRow.role === "viewer") {
    return err(new AppError("FORBIDDEN_ROLE", "Tu rol es de solo lectura."));
  }

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

  // ── 5. Fetch case (explicit tenant filter — wrong tenant returns null → 404) ─
  let caseRow: { id: string; status: string; tenant_id: string } | null;
  try {
    caseRow = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({
            id: cases.id,
            status: cases.status,
            tenant_id: cases.tenant_id,
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
    // AC19: Always 404, never 403 — no tenant enumeration.
    return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
  }

  const currentStatus = caseRow.status as CaseStatus;
  const tenantId = caseRow.tenant_id;

  // ── 6. Find pending claim_field_confirmations row ─────────────────────────
  // Neon column names are field_name / suggested_value — aliased to preserve
  // the previous field_key / proposed_value shape.
  let confirmationRow: {
    id: string;
    proposed_value: string | null;
    conflict_with_value: string | null;
    status: string;
  } | null;
  try {
    confirmationRow = firstRow(
      await enTenant(tenantCtx, (db) =>
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
    return err(new AppError("INTERNAL_ERROR"));
  }

  // Allow confirm even if no pending confirmation row exists (direct field update).
  // The confirmation row is optional — analysts can also confirm fields that
  // were extracted with high confidence but need an explicit human stamp.

  const now = new Date().toISOString();

  // ── 7. Handle action ──────────────────────────────────────────────────────

  if (action === "confirm" || action === "correct") {
    // ── 7a. Update claim_field_confirmations status ────────────────────────
    if (confirmationRow) {
      try {
        await enTenant(tenantCtx, (db) =>
          db
            .update(claimFieldConfirmations)
            .set({
              status: action === "confirm" ? "confirmed" : "corrected",
              confirmed_by: userRow.id,
              confirmed_at: now,
            })
            .where(
              eq(claimFieldConfirmations.id, confirmationRow.id)
            )
        );
      } catch (e) {
        console.error("[confirm-field] confirmation update error:", dbErrCode(e));
      }
    }

    // ── 7b. Upsert extracted_fields with confirmed value ───────────────────
    if (confirmedValue !== null && confirmedValue !== undefined) {
      try {
        await db
          .insert(extractedFields)
          .values({
            case_id: caseId,
            tenant_id: tenantId,
            field_key: fieldKey,
            field_value: confirmedValue,
            confidence: "1.00", // Human-confirmed fields have 100% confidence.
          })
          .onConflictDoUpdate({
            target: [extractedFields.case_id, extractedFields.field_key],
            set: {
              field_value: sql`excluded.field_value`,
              confidence: sql`excluded.confidence`,
            },
          });
      } catch (e) {
        console.error("[confirm-field] extracted_fields upsert error:", dbErrCode(e));
      }

      // ── 7c. Satisfy missing_docs if this field was missing ────────────────
      try {
        await enTenant(tenantCtx, (db) =>
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

      // ── 7d. Update claim_memory — AC14 ────────────────────────────────────
      // Get sender email from raw_messages for this case.
      const senderEmail = await getSenderEmail(caseId, tenantId);

      let memoryUpdated = false;
      if (senderEmail) {
        const oldValue = confirmationRow?.proposed_value ?? undefined;
        await updateMemoryFromConfirmation(
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
      try {
        await enTenant(tenantCtx, (db) =>
          db
            .update(claimFieldConfirmations)
            .set({
              status: "rejected",
              confirmed_by: userRow.id,
              confirmed_at: now,
            })
            .where(
              eq(claimFieldConfirmations.id, confirmationRow.id)
            )
        );
      } catch (e) {
        console.error("[confirm-field] reject update error:", dbErrCode(e));
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
 * Get the sender email from raw_messages for a case (tenant-scoped).
 * Returns null if not found (graceful degradation — memory update is skipped).
 */
async function getSenderEmail(
  caseId: string,
  tenantId: string
): Promise<string | null> {
  const tenantCtx: TenantContext = { tenantId };
  try {
    const row = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ from_addr: rawMessages.from_addr })
          .from(rawMessages)
          .where(
            eq(rawMessages.case_id, caseId)
          )
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
  caseId: string,
  currentStatus: CaseStatus,
  tenantId: string,
  actorId: string
): Promise<string> {
  const tenantCtx: TenantContext = { tenantId };
  try {
    // Fetch current extracted fields for gap analysis.
    const fields = await enTenant(tenantCtx, (db) =>
      db
        .select({
          field_key: extractedFields.field_key,
          field_value: extractedFields.field_value,
          confidence: extractedFields.confidence,
        })
        .from(extractedFields)
        .where(
          eq(extractedFields.case_id, caseId)
        )
    );

    // numeric → string under Drizzle; convert. The Neon schema has no `source`
    // column — default to "ai" (matches the previous `?? "ai"` fallback).
    const currentFields = fields.map((f) => ({
      field_key: f.field_key,
      field_value: f.field_value,
      confidence: Number(f.confidence),
      source: "ai" as const,
    }));

    const gapResult = await analyzeEmailClaimGaps(caseId, currentFields, tenantId);

    const newStatus = gapResult.status as CaseStatus;

    // Only transition if FSM allows it.
    if (newStatus !== currentStatus && isValidTransition(currentStatus, newStatus)) {
      try {
        await enTenant(tenantCtx, (db) =>
          db
            .update(cases)
            .set({
              status: newStatus,
              updated_at: new Date().toISOString(),
            })
            .where(eq(cases.id, caseId))
        );
      } catch (e) {
        console.error("[confirm-field] status update error:", dbErrCode(e));
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
  } catch (e) {
    const errName = e instanceof Error ? e.name : "UnknownError";
    console.error("[confirm-field] reEvaluateStatus error:", errName);
    return currentStatus;
  }
}
