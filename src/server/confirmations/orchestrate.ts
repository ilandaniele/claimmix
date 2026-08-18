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
 *   F. confirmation_received — only when no other branch already wrote (AC12)
 *
 * AC7:  Medium-confidence field → claim_field_confirmations row + data_confirmation_request
 * AC9:  Conflict with stored customer → claim_field_confirmations conflict row + data_confirmation_request
 * AC10: Missing required fields → missing_information_request + status=info_faltante
 * AC11: High/critical severity → specialist_escalation + status=requiere_especialista
 * AC12: confirmation_received dispatched for is_claim=true, except when another
 *       branch already wrote — every one of them acknowledges receipt and
 *       carries the case number, so this would be a second, emptier email
 *
 * LLM08: This module cannot set terminal states; only sets AI_ALLOWED_STATUSES.
 * LLM06: PII (email addresses) is never logged — only case_id and field_key.
 */

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { cases, claimFieldConfirmations, outboundMessages } from "@/lib/db/schema";
import type { CaseRow } from "@/lib/db/types";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { CustomerMatch } from "@/server/matching/customer-matcher";
import { analyzeEmailClaimGaps, MEDIUM_CONFIDENCE_HIGH } from "@/server/cases/gap-analyzer";
import {
  canonicalFieldKey,
  confirmationRank,
  isWorthConfirming,
} from "@/lib/labels/claim-fields";
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

  // ── Gap analysis runs first: it is the authority on what is uncertain ─────
  //
  // It used to run at step E, after the confirmation branches had already
  // decided who to ask. That left two independent opinions about the same
  // question. The gap analyzer recomputes the medium-confidence band from the
  // extracted fields; the extractor also emits its own
  // `fields_pending_confirmation` list. In production they disagreed: a case
  // landed in `confirmacion_pendiente` because the analyzer saw claim_type at
  // 0.60, while no email went out because the extractor had left its list
  // empty. The board said "waiting on the claimant" about a question nobody
  // had been asked, and the case would have sat there forever.
  // A field the claimant has now answered is no longer pending. Runs BEFORE
  // the gap analysis, which reads those rows.
  await resolveAnsweredConfirmations(caseId, tenantId, extractedClaim.fields);

  const gapResult = await analyzeEmailClaimGaps(caseId, extractedClaim.fields, tenantId);

  // ── C. Medium-confidence fields → confirmation rows — AC7 ─────────────────
  //
  // Union of both opinions: if either side thinks a field is uncertain, ask.
  // Conflicts are excluded — branch D owns those and has the stored value to
  // show alongside.
  const uncertainKeys = [
    ...(extractedClaim.fields_pending_confirmation ?? []),
    ...gapResult.fieldsNeedingConfirmation
      .filter((f) => f.reason !== "conflict")
      .map((f) => f.fieldName),
  ];

  const pendingConfirmationFields = collectConfirmableFields(
    uncertainKeys,
    extractedClaim.fields
  );

  for (const field of pendingConfirmationFields) {
    const { fieldKey, proposedValue, confidence } = field;

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

  // Also dispatch data_confirmation_request for medium-confidence pending
  // fields — but only when this is the one thing we are asking for.
  //
  // Skipped when required fields are missing: branch E is about to send
  // missing_information_request, and two "necesitamos algo tuyo" emails landing
  // together is the same pile-up we removed from the escalation path. The rows
  // above are still written, so the uncertainty is on the record for an analyst
  // and the next round can ask once the bigger gap is closed.
  const missingInfoEmailComing = gapResult.missingRequiredFields.length > 0;
  let missingInfoEmailDispatched = false;

  if (
    pendingConfirmationFields.length > 0 &&
    !confirmationEmailDispatched &&
    !missingInfoEmailComing
  ) {
    const target = pendingConfirmationFields[0];

    await dispatchOutboundEmail({
      caseId,
      tenantId,
      to: senderEmail,
      template: "data_confirmation_request",
      data: {
        caseId,
        fieldKey: target.fieldKey,
        proposedValue: target.proposedValue,
        conflictWithValue: null,
      },
      inReplyToMessageId,
    });
    confirmationEmailDispatched = true;

    // The case is now genuinely waiting on the claimant, so say so. Without
    // this the status came from whatever the gap analyzer computed, which
    // knows nothing about the email we just sent.
    await setStatus(caseId, tenantId, "confirmacion_pendiente");
  }

  // ── E. Act on the gap analysis — AC10 ────────────────────────────────────

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

    missingInfoEmailDispatched = true;

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
    // Not when escalated, and not when we just asked the claimant to confirm
    // something — the gap analysis ran before that email existed, so on its own
    // it would call the case ready while an unanswered question is in flight.
    if (!isHighSeverity && !confirmationEmailDispatched) {
      await setStatus(caseId, tenantId, "listo_para_core");
    }
  }

  // ── F. Acknowledge receipt — but only if nothing else already did ─────────
  //
  // confirmation_received is the fallback, not a fixture: it exists so a
  // claimant is never left without an answer. Every other branch already
  // acknowledges receipt and carries the case number, so adding this one on top
  // means two emails landing in the same second, the second saying less than
  // the first. A person handling the claim would send one message.
  //
  // The escalation was the first case of this — someone reporting a fire got
  // three at once. The rule generalises: if we said anything at all, we said
  // it, and this adds nothing.
  const somethingElseWasSaid =
    isHighSeverity || confirmationEmailDispatched || missingInfoEmailDispatched;

  if (!somethingElseWasSaid && !(await checkConfirmationAlreadySent(caseId, tenantId))) {
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

/**
 * Close the confirmations the claimant just answered.
 *
 * Without this the case loops. A pending row is written when a field is
 * uncertain; the gap analyzer reads pending rows straight back out as "needs
 * confirmation"; the orchestrator then re-asks and rewrites the row as pending.
 * So a claimant who replied "fue un choque" — lifting claim_type from 0.70 to
 * 0.90 — was asked to confirm "choque de vehículo", the thing they had just
 * said in their own words, and would have been asked again after answering
 * that, forever.
 *
 * `confirmed` rather than `corrected`: the value we hold now came from the
 * claimant, whether they restated it or we simply read the message better.
 */
async function resolveAnsweredConfirmations(
  caseId: string,
  tenantId: string,
  fields: ExtractedClaim["fields"]
): Promise<void> {
  const settled = [
    ...new Set(
      fields
        .filter((f) => f.confidence >= MEDIUM_CONFIDENCE_HIGH)
        .map((f) => canonicalFieldKey(f.field_key))
    ),
  ];

  if (settled.length === 0) return;

  try {
    await db
      .update(claimFieldConfirmations)
      .set({ status: "confirmed" })
      .where(
        and(
          eq(claimFieldConfirmations.case_id, caseId),
          eq(claimFieldConfirmations.tenant_id, tenantId),
          eq(claimFieldConfirmations.status, "pending"),
          inArray(claimFieldConfirmations.field_name, settled)
        )
      );
  } catch (err) {
    console.error("[orchestrate] Failed to resolve confirmations:", errCode(err));
  }
}

interface ConfirmableField {
  fieldKey: string;
  proposedValue: string;
  confidence: number;
}

/**
 * Turn a pile of uncertain field keys into the questions actually worth asking,
 * best first.
 *
 * Three things happen here, each from a request that went out to a real inbox:
 *
 *  - Narrative fields are dropped. One email asked someone to confirm "Qué
 *    pasó" by quoting back the sentence they had just written.
 *  - Aliases collapse. The extractor emits `accident_description` and
 *    `descripcion_hecho` with identical text, so two rows appeared for one
 *    question; the higher-confidence copy wins.
 *  - Order is by how much the answer is worth, then by confidence. Sorting on
 *    confidence alone was useless: the model returns whole groups at exactly
 *    0.70, and the tie silently fell back to emission order.
 */
function collectConfirmableFields(
  uncertainKeys: string[],
  extracted: ExtractedClaim["fields"]
): ConfirmableField[] {
  const byCanonical = new Map<string, ConfirmableField>();

  for (const rawKey of uncertainKeys) {
    if (!isWorthConfirming(rawKey)) continue;

    const canonical = canonicalFieldKey(rawKey);

    // The value may be filed under either spelling — take the most confident.
    const candidates = extracted.filter(
      (f) => canonicalFieldKey(f.field_key) === canonical
    );
    const best = candidates.reduce<ExtractedClaim["fields"][number] | null>(
      (acc, f) => (acc === null || f.confidence > acc.confidence ? f : acc),
      null
    );

    const existing = byCanonical.get(canonical);
    const confidence = best?.confidence ?? 0;
    if (existing && existing.confidence >= confidence) continue;

    byCanonical.set(canonical, {
      fieldKey: canonical,
      proposedValue: best?.field_value ?? "",
      confidence,
    });
  }

  return [...byCanonical.values()].sort(
    (a, b) =>
      confirmationRank(a.fieldKey) - confirmationRank(b.fieldKey) ||
      a.confidence - b.confidence
  );
}

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
