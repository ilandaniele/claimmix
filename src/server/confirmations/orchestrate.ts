/**
 * Post-extraction orchestrator — decides what emails to send and what
 * status transitions to apply after the extraction worker completes.
 *
 * Called by runEmailExtractionWorker after all DB persists are done.
 *
 * Decision tree:
 *   A. is_claim=false → return early (no email)
 *   B. High/critical severity → specialist_escalation + confirmation_received
 *   C. fields_pending_confirmation → insert claim_field_confirmations rows + data_confirmation_request
 *   D. Conflict in customer matches → claim_field_confirmations conflict rows + data_confirmation_request
 *   E. Gap analysis → missing_information_request (info_faltante) OR update status
 *   F. ALWAYS send confirmation_received for is_claim=true (AC12)
 *
 * AC7:  Medium-confidence field → claim_field_confirmations row + data_confirmation_request
 * AC9:  Conflict with stored customer → claim_field_confirmations conflict row + data_confirmation_request
 * AC10: Missing required fields → missing_information_request + status=info_faltante
 * AC11: High/critical severity → specialist_escalation + status=requiere_especialista
 * AC12: confirmation_received always dispatched for is_claim=true
 *
 * LLM08: This module cannot set terminal states; only sets AI_ALLOWED_STATUSES.
 * LLM06: PII (email addresses) is never logged — only case_id and field_key.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
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
 * @param supabase         - Service-role Supabase client (DB writes bypass RLS).
 * @param caseId           - UUID of the case.
 * @param tenantId         - UUID of the tenant.
 * @param extractedOutput  - Extraction result + sender info.
 * @param customerMatches  - Customer matches from the customer-matcher module.
 */
export async function orchestratePostExtraction(
  supabase: SupabaseClient,
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
    await setStatus(supabase, caseId, "requiere_especialista");

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
    await upsertFieldConfirmation(supabase, caseId, tenantId, {
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
      await upsertFieldConfirmation(supabase, caseId, tenantId, {
        field_key: conflictField,
        proposed_value: extractedValue,
        confidence,
        conflict_with_value: storedValue,
      });

      // Set case status to confirmacion_pendiente for conflict.
      await setStatus(supabase, caseId, "confirmacion_pendiente");

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
    supabase
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
    await setStatus(supabase, caseId, "info_faltante");

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
    await setStatus(supabase, caseId, "confirmacion_pendiente");
  } else if (gapResult.status === "listo_para_core") {
    // All required fields present + no pending confirmations.
    // Only set listo_para_core if not escalated.
    if (!isHighSeverity) {
      await setStatus(supabase, caseId, "listo_para_core");
    }
  }

  // ── F. Always send confirmation_received for valid claims — AC12 ──────────
  // Check if a confirmation_received email has already been sent for this case.
  const alreadySent = await checkConfirmationAlreadySent(supabase, caseId);

  if (!alreadySent) {
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

/** Update the case status (no FSM transition check — worker already validated). */
async function setStatus(
  supabase: SupabaseClient,
  caseId: string,
  status: string
): Promise<void> {
  const { error } = await (supabase as any)
    .from("cases")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", caseId);

  if (error) {
    console.error("[orchestrate] Failed to update case status:", error.code, "case:", caseId);
  }
}

/** Upsert a claim_field_confirmations row. Avoids duplicate pending rows. */
async function upsertFieldConfirmation(
  supabase: SupabaseClient,
  caseId: string,
  tenantId: string,
  row: {
    field_key: string;
    proposed_value: string;
    confidence: number;
    conflict_with_value: string | null;
  }
): Promise<void> {
  const { error } = await (supabase as any)
    .from("claim_field_confirmations")
    .upsert(
      {
        case_id: caseId,
        tenant_id: tenantId,
        field_key: row.field_key,
        proposed_value: row.proposed_value,
        conflict_with_value: row.conflict_with_value,
        confidence: parseFloat(row.confidence.toFixed(2)),
        status: "pending",
        created_at: new Date().toISOString(),
      },
      // Upsert on (case_id, field_key) — only one pending row per field per case.
      { onConflict: "case_id,field_key", ignoreDuplicates: false }
    );

  if (error) {
    console.error("[orchestrate] Failed to upsert claim_field_confirmations:", error.code);
  }
}

/**
 * Check whether a confirmation_received email has already been dispatched
 * for this case. Used to enforce the AC12 "always send, but only once" rule.
 */
async function checkConfirmationAlreadySent(
  supabase: SupabaseClient,
  caseId: string
): Promise<boolean> {
  try {
    const { data, error } = await (supabase as any)
      .from("outbound_messages")
      .select("id")
      .eq("case_id", caseId)
      .eq("template", "confirmation_received")
      .limit(1);

    if (error) {
      console.error("[orchestrate] Failed to check outbound_messages:", error.code);
      return false;
    }

    return (data ?? []).length > 0;
  } catch {
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
