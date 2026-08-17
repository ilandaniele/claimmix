/**
 * Post-extraction orchestrator — decides what emails to send and what
 * status transitions to apply after the extraction worker completes.
 *
 * Called by runEmailExtractionWorker after all DB persists are done.
 *
 * Decision tree:
 *   A. is_claim=false → return early (no email)
 *   B. High/critical severity → specialist_escalation (and no confirmation_received)
 *   C. fields_pending_confirmation → insert claim_field_confirmations rows + data_confirmation_request
 *   D. Conflict in customer matches → claim_field_confirmations conflict rows + data_confirmation_request
 *   E. Gap analysis → missing_information_request (info_faltante) OR update status
 *   F. confirmation_received for is_claim=true, unless already escalated (AC12)
 *
 * AC7:  Medium-confidence field → claim_field_confirmations row + data_confirmation_request
 * AC9:  Conflict with stored customer → claim_field_confirmations conflict row + data_confirmation_request
 * AC10: Missing required fields → missing_information_request + status=info_faltante
 * AC11: High/critical severity → specialist_escalation + status=requiere_especialista
 * AC12: confirmation_received dispatched for is_claim=true, except when the case
 *       was escalated — the escalation email already acknowledges receipt
 *
 * LLM08: This module cannot set terminal states; only sets AI_ALLOWED_STATUSES.
 * LLM06: PII (email addresses) is never logged — only case_id and field_key.
 */

import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { cases, claimFieldConfirmations, outboundMessages } from "@/lib/db/schema";
import type { CaseRow } from "@/lib/db/types";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { CustomerMatch } from "@/server/matching/customer-matcher";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";
import { dispatchOutboundEmail } from "@/server/email/dispatch";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractedClaimOutput {
  extractedClaim: ExtractedClaim;
  senderEmail: string;
  inReplyToMessageId?: string;
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Run the post-extraction orchestration pipeline.
 *
 * Idempotent within a single extraction run — checks for existing
 * outbound_messages and claim_field_confirmations before inserting.
 *
 * @param caseId           - UUID of the case.
 * @param tenantId         - UUID of the tenant (explicit tenant scoping — RLS is gone).
 * @param extractedOutput  - Extraction result + sender info.
 * @param customerMatches  - Customer matches from the customer-matcher module.
 */
export async function orchestratePostExtraction(
  caseId: string,
  tenantId: string,
  extractedOutput: ExtractedClaimOutput,
  customerMatches: CustomerMatch[]
): Promise<void> {
  const { extractedClaim, senderEmail, inReplyToMessageId } = extractedOutput;

  // ── A. Non-claim email — return early ─────────────────────────────────────
  if (extractedClaim.is_claim === false) {
    // Already handled by extraction worker (status=no_relevante).
    // No email should be sent for non-claim emails (AC5).
    return;
  }

  let confirmationEmailDispatched = false;

  // ── B. Severity escalation — AC11 ────────────────────────────────────────
  const severity = extractedClaim.severity;
  const isHighSeverity = severity === "high" || severity === "critical";

  if (isHighSeverity) {
    // Ensure status is requiere_especialista (may already be set by worker).
    await setStatus(caseId, tenantId, "requiere_especialista");

    // Dispatch specialist escalation email to claimant.
    await dispatchOutboundEmail({
      caseId,
      tenantId,
      to: senderEmail,
      template: "specialist_escalation",
      data: { caseId, severity },
      inReplyToMessageId,
    });

    // Log SPECIALIST_REQUIRED audit event.
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.SPECIALIST_REQUIRED,
      target_type: "case",
      target_id: caseId,
      payload: { severity },
    });
  }

  // ── C. Medium-confidence fields → confirmation rows — AC7 ─────────────────
  const pendingConfirmationFields = extractedClaim.fields_pending_confirmation ?? [];

  for (const fieldKey of pendingConfirmationFields) {
    const extractedFieldEntry = extractedClaim.fields.find((f) => f.field_key === fieldKey);
    const proposedValue = extractedFieldEntry?.field_value ?? "";
    const confidence = extractedFieldEntry?.confidence ?? 0;

    // Insert claim_field_confirmations row (upsert to avoid duplicates).
    await upsertFieldConfirmation(caseId, tenantId, {
      field_key: fieldKey,
      proposed_value: proposedValue,
      confidence,
      conflict_with_value: null,
    });

    // Audit: CONFIRMATION_REQUESTED (field key only — no PII value in payload).
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.CONFIRMATION_REQUESTED,
      target_type: "case",
      target_id: caseId,
      payload: { field_key: fieldKey },
    });
  }

  // ── D. Customer conflict → confirmation rows — AC9 ────────────────────────
  for (const match of customerMatches) {
    if (match.conflictsWithExtracted.length === 0) continue;

    for (const conflictField of match.conflictsWithExtracted) {
      // Get the extracted value for this conflicting field.
      const extractedEntry = extractedClaim.fields.find((f) => f.field_key === conflictField);
      const extractedValue = extractedEntry?.field_value ?? "";
      const confidence = extractedEntry?.confidence ?? 0;

      // The stored value — which field in the customer record?
      const storedValue = getStoredFieldValue(match, conflictField);

      // Insert conflict confirmation row (extracted value vs stored customer value).
      await upsertFieldConfirmation(caseId, tenantId, {
        field_key: conflictField,
        proposed_value: extractedValue,
        confidence,
        conflict_with_value: storedValue,
      });

      // Set case status to confirmacion_pendiente for conflict.
      await setStatus(caseId, tenantId, "confirmacion_pendiente");

      // Dispatch data_confirmation_request email.
      await dispatchOutboundEmail({
        caseId,
        tenantId,
        to: senderEmail,
        template: "data_confirmation_request",
        data: {
          caseId,
          fieldKey: conflictField,
          proposedValue: extractedValue,
          conflictWithValue: storedValue,
        },
        inReplyToMessageId,
      });
      confirmationEmailDispatched = true;

      // Audit: CONFIRMATION_REQUESTED (field key only — no PII).
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: null,
        event_type: AuditEvent.CONFIRMATION_REQUESTED,
        target_type: "case",
        target_id: caseId,
        payload: { field_key: conflictField, reason: "conflict" },
      });
    }
  }

  // Also dispatch data_confirmation_request for medium-confidence pending fields
  // if no conflict email was dispatched yet (avoid spamming multiple emails).
  if (pendingConfirmationFields.length > 0 && !confirmationEmailDispatched) {
    const firstPendingField = pendingConfirmationFields[0];
    const extractedEntry = extractedClaim.fields.find(
      (f) => f.field_key === firstPendingField
    );

    await dispatchOutboundEmail({
      caseId,
      tenantId,
      to: senderEmail,
      template: "data_confirmation_request",
      data: {
        caseId,
        fieldKey: firstPendingField,
        proposedValue: extractedEntry?.field_value ?? "",
        conflictWithValue: null,
      },
      inReplyToMessageId,
    });
    confirmationEmailDispatched = true;
  }

  // ── E. Gap analysis — AC10 ───────────────────────────────────────────────
  const gapResult = await analyzeEmailClaimGaps(
    caseId,
    extractedClaim.fields,
    tenantId
  );

  if (gapResult.missingRequiredFields.length > 0) {
    // Missing required fields → dispatch missing_information_request.
    // Include only the actual missing field keys (not email_or_phone alias).
    const missingFieldsForEmail = gapResult.missingRequiredFields.filter(
      (f) => f !== "email_or_phone"
    );
    // If email_or_phone was the only "missing" contact, add both to the list.
    if (
      gapResult.missingRequiredFields.includes("email_or_phone") &&
      missingFieldsForEmail.length === gapResult.missingRequiredFields.length - 1
    ) {
      missingFieldsForEmail.push("email");
    }

    await dispatchOutboundEmail({
      caseId,
      tenantId,
      to: senderEmail,
      template: "missing_information_request",
      data: {
        caseId,
        missingFields: missingFieldsForEmail.length > 0
          ? missingFieldsForEmail
          : gapResult.missingRequiredFields,
      },
      inReplyToMessageId,
    });

    // Update status to info_faltante.
    await setStatus(caseId, tenantId, "info_faltante");

    // Audit: MISSING_INFO_REQUESTED.
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.MISSING_INFO_REQUESTED,
      target_type: "case",
      target_id: caseId,
      payload: { missing_fields: gapResult.missingRequiredFields },
    });
  } else if (gapResult.status === "confirmacion_pendiente") {
    // Pending confirmations, no missing required fields.
    await setStatus(caseId, tenantId, "confirmacion_pendiente");
  } else if (gapResult.status === "listo_para_core") {
    // All required fields present + no pending confirmations.
    // Only set listo_para_core if not escalated.
    if (!isHighSeverity) {
      await setStatus(caseId, tenantId, "listo_para_core");
    }
  }

  // ── F. Send confirmation_received for valid claims — AC12 ─────────────────
  //
  // Not when the case was escalated. Branch B already told the claimant we
  // received it, gave them the case number and said a specialist will call
  // within 24h — a generic "recibimos tu denuncia" on top of that is the third
  // simultaneous email someone gets right after reporting a fire or an injury,
  // and it says less than the one they already have. The escalation IS the
  // acknowledgement.
  //
  // Nothing is lost by skipping it: everything confirmation_received carries
  // (case id, receipt) is in the escalation email, which also outranks it.
  if (!isHighSeverity && !(await checkConfirmationAlreadySent(caseId, tenantId))) {
    // Extract claim_type and policy_number from fields for the email template.
    const claimTypeField = extractedClaim.fields.find((f) => f.field_key === "claim_type");
    const policyField = extractedClaim.fields.find((f) => f.field_key === "policy_number");

    await dispatchOutboundEmail({
      caseId,
      tenantId,
      to: senderEmail,
      template: "confirmation_received",
      data: {
        caseId,
        claimType: claimTypeField?.field_value ?? null,
        // policyNumber passed through; template masks it (AC24).
        policyNumber: policyField?.field_value ?? null,
      },
      inReplyToMessageId,
    });
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Extract a loggable error code from a thrown DB error (PII-safe). */
function errCode(err: unknown): string {
  return (
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.name : "UnknownError")
  );
}

/** Update the case status (no FSM transition check — worker already validated). */
async function setStatus(
  caseId: string,
  tenantId: string,
  status: string
): Promise<void> {
  try {
    await db
      .update(cases)
      .set({
        status: status as CaseRow["status"],
        updated_at: new Date().toISOString(),
      })
      .where(and(eq(cases.id, caseId), eq(cases.tenant_id, tenantId)));
  } catch (err) {
    console.error("[orchestrate] Failed to update case status:", errCode(err), "case:", caseId);
  }
}

/**
 * Upsert a claim_field_confirmations row. Avoids duplicate pending rows.
 *
 * NOTE: the Neon schema has no unique constraint on (case_id, field_name),
 * so the "only one row per field per case" rule is emulated with an
 * update-then-insert (no ON CONFLICT target available).
 */
async function upsertFieldConfirmation(
  caseId: string,
  tenantId: string,
  row: {
    field_key: string;
    proposed_value: string;
    confidence: number;
    conflict_with_value: string | null;
  }
): Promise<void> {
  try {
    const existing = firstRow(
      await db
        .select({ id: claimFieldConfirmations.id })
        .from(claimFieldConfirmations)
        .where(
          and(
            eq(claimFieldConfirmations.case_id, caseId),
            eq(claimFieldConfirmations.tenant_id, tenantId),
            eq(claimFieldConfirmations.field_name, row.field_key)
          )
        )
        .limit(1)
    );

    const values = {
      suggested_value: row.proposed_value,
      conflict_with_value: row.conflict_with_value,
      confidence: row.confidence.toFixed(2),
      status: "pending",
      created_at: new Date().toISOString(),
    };

    if (existing) {
      await db
        .update(claimFieldConfirmations)
        .set(values)
        .where(eq(claimFieldConfirmations.id, existing.id));
    } else {
      await db.insert(claimFieldConfirmations).values({
        case_id: caseId,
        tenant_id: tenantId,
        field_name: row.field_key,
        ...values,
      });
    }
  } catch (err) {
    console.error("[orchestrate] Failed to upsert claim_field_confirmations:", errCode(err));
  }
}

/**
 * Check whether a confirmation_received email has already been dispatched
 * for this case. Used to enforce the AC12 "always send, but only once" rule.
 */
async function checkConfirmationAlreadySent(
  caseId: string,
  tenantId: string
): Promise<boolean> {
  try {
    const data = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.case_id, caseId),
          eq(outboundMessages.tenant_id, tenantId),
          eq(outboundMessages.template, "confirmation_received")
        )
      )
      .limit(1);

    return data.length > 0;
  } catch (err) {
    console.error("[orchestrate] Failed to check outbound_messages:", errCode(err));
    return false;
  }
}

/**
 * Extract the stored (customer record) value for a conflicting field.
 * Used to populate conflict_with_value in claim_field_confirmations.
 *
 * LLM06: We do not log this value — caller ensures no PII in audit payloads.
 */
function getStoredFieldValue(
  match: CustomerMatch,
  fieldKey: string
): string {
  // The CustomerMatch interface does not directly expose the stored field values.
  // We use the customerName for full_name conflicts (the most common case).
  // For other fields, we return an empty string — the conflict is flagged but
  // the exact stored value is not available from this interface.
  if (fieldKey === "full_name") {
    return match.customerName;
  }
  // For email, dni, phone — the stored value is in the DB but not passed through
  // the match interface. For now, we flag the conflict without the stored value.
  // The analyst can see the stored value in the admin dashboard (W5/W6).
  return "";
}
