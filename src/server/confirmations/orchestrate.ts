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
  isAffirmativeReply,
  isDerivable,
  isWorthConfirming,
} from "@/lib/labels/claim-fields";
import { emailMessenger, type AgentMessenger } from "@/server/confirmations/messenger";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractedClaimOutput {
  extractedClaim: ExtractedClaim;
  senderEmail: string;
  inReplyToMessageId?: string;
  /**
   * Body of the newest inbound message, on its own.
   *
   * Separate from the conversation the extractor reads, because "Confirmo" is
   * answered by the fact that they said it, not by anything extraction can
   * find in it.
   */
  latestMessageText?: string;
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
  customerMatches: CustomerMatch[],
  /**
   * How to deliver what this decides. Defaults to email, which is where the
   * decision tree grew up; WhatsApp passes its own so the two channels share
   * the reasoning instead of each keeping a copy that drifts.
   */
  messenger: AgentMessenger = emailMessenger
): Promise<void> {
  const { extractedClaim, senderEmail, inReplyToMessageId, latestMessageText } =
    extractedOutput;

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
    await messenger.send({
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
  // the gap analysis, which reads those rows straight back out.
  await resolveAnsweredConfirmations(
    caseId,
    tenantId,
    extractedClaim.fields,
    latestMessageText
  );

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
      await messenger.send({
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

  const missingInfoEmailComing = gapResult.missingRequiredFields.length > 0;
  let missingInfoEmailDispatched = false;

  // ── E. Act on the gap analysis — AC10 ────────────────────────────────────

  // Everything we need from the claimant, in one message.
  //
  // Gaps and doubts used to go out as separate emails on separate rounds — the
  // policy number today, what kind of accident it was tomorrow. Neither
  // question depends on the other's answer, so the chain was ours to make and
  // ours to stop making. A person handling the claim writes one message
  // listing what they need.
  const askItems = buildAskList(gapResult.missingRequiredFields, pendingConfirmationFields);

  if (askItems.fields.length > 0 && !confirmationEmailDispatched) {
    await messenger.send({
      caseId,
      tenantId,
      to: senderEmail,
      template: "missing_information_request",
      data: {
        caseId,
        missingFields: askItems.fields,
        knownValues: askItems.knownValues,
      },
      inReplyToMessageId,
    });

    missingInfoEmailDispatched = true;

    // A genuine gap outranks a doubt: the case is blocked, not merely unsure.
    await setStatus(
      caseId,
      tenantId,
      missingInfoEmailComing ? "info_faltante" : "confirmacion_pendiente"
    );

    // Audit: MISSING_INFO_REQUESTED.
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.MISSING_INFO_REQUESTED,
      target_type: "case",
      target_id: caseId,
      payload: { missing_fields: gapResult.missingRequiredFields },
    });
  } else if (!isHighSeverity && !confirmationEmailDispatched) {
    // Nothing was asked, so nothing is being waited on.
    //
    // The analyzer can return confirmacion_pendiente over doubts we decided are
    // not worth an email — a derived province, a field ranked below the cap.
    // Taking that status at face value parked a complete claim as "waiting on
    // the claimant" in the same run that sent them a message saying we had
    // everything. A doubt nobody was asked about is a note for the analyst, not
    // a block on the case.
    //
    // The branches that do send a question set their own status above, so
    // reaching here means the conversation is finished as far as we are
    // concerned.
    await setStatus(caseId, tenantId, "listo_para_core");
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
    // Have we written to this claimant before? If so this is a closing, not an
    // acknowledgement, and it should not open by thanking them for getting in
    // touch two rounds after they did.
    const isFollowUp = await hasPriorOutbound(caseId, tenantId);

    // Extract claim_type and policy_number from fields for the email template.
    const claimTypeField = extractedClaim.fields.find((f) => f.field_key === "claim_type");
    const policyField = extractedClaim.fields.find((f) => f.field_key === "policy_number");

    await messenger.send({
      caseId,
      tenantId,
      to: senderEmail,
      template: "confirmation_received",
      data: {
        caseId,
        claimType: claimTypeField?.field_value ?? null,
        // policyNumber passed through; template masks it (AC24).
        policyNumber: policyField?.field_value ?? null,
        isFollowUp,
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
  fields: ExtractedClaim["fields"],
  latestMessageText?: string
): Promise<void> {
  const settled = new Set(
    fields
      .filter((f) => f.confidence >= MEDIUM_CONFIDENCE_HIGH)
      .map((f) => canonicalFieldKey(f.field_key))
  );

  // "Confirmo" is an answer even though it adds no data. The email asks for
  // that exact word and nothing read it, so the claimant wrote it, extraction
  // re-ran, the inferred value came back at the same confidence it always had,
  // and the identical email went out again. Answering the way we asked left
  // them where they started.
  //
  // It closes the one field we asked about, not every pending row: we only ever
  // ask about one per email, and the same ranking that picked it picks it now.
  if (isAffirmativeReply(latestMessageText)) {
    for (const asked of await askedPendingFields(caseId, tenantId, fields)) {
      settled.add(asked);
    }
  }

  if (settled.size === 0) return;

  try {
    await db
      .update(claimFieldConfirmations)
      .set({ status: "confirmed" })
      .where(
        and(
          eq(claimFieldConfirmations.case_id, caseId),
          eq(claimFieldConfirmations.tenant_id, tenantId),
          eq(claimFieldConfirmations.status, "pending"),
          inArray(claimFieldConfirmations.field_name, [...settled])
        )
      );
  } catch (err) {
    console.error("[orchestrate] Failed to resolve confirmations:", errCode(err));
  }
}

/**
 * The pending fields the last email actually put in front of them.
 *
 * "Confirmo" agrees with what was on the page, so it must not close a doubt
 * that never made the list — the cap can leave some out. Recomputed rather
 * than stored: same rows, same ranking, same subset the email showed.
 */
async function askedPendingFields(
  caseId: string,
  tenantId: string,
  fields: ExtractedClaim["fields"]
): Promise<string[]> {
  try {
    const rows = await db
      .select({ field_name: claimFieldConfirmations.field_name })
      .from(claimFieldConfirmations)
      .where(
        and(
          eq(claimFieldConfirmations.case_id, caseId),
          eq(claimFieldConfirmations.tenant_id, tenantId),
          eq(claimFieldConfirmations.status, "pending")
        )
      );

    const ranked = collectConfirmableFields(
      rows.map((r) => r.field_name),
      fields
    );
    return buildAskList([], ranked).fields;
  } catch (err) {
    console.error("[orchestrate] Failed to read pending confirmations:", errCode(err));
    return [];
  }
}

/**
 * How many things one email may ask for.
 *
 * A real extraction flagged thirteen gaps at once. Sending someone who just
 * crashed their car thirteen demands gets no reply at all — the WhatsApp side
 * learned this first and caps at the same number.
 */
const MAX_ASK_ITEMS = 5;

/**
 * The single list of everything we need, gaps and doubts together.
 *
 * Order is deliberate: what is missing blocks the claim, what is uncertain only
 * slows it. `email_or_phone` is an internal alias for "either of these", so it
 * goes out as the contact field a person recognises.
 *
 * Deterministic, because two callers depend on agreeing: the branch that sends
 * the email and the one that decides what a bare "Confirmo" answered.
 */
function buildAskList(
  missingRequiredFields: string[],
  pending: ConfirmableField[]
): { fields: string[]; knownValues: Record<string, string> } {
  const missing = missingRequiredFields.map((f) =>
    f === "email_or_phone" ? "email" : f
  );

  const seen = new Set(missing);
  const doubts = pending.filter((p) => !seen.has(p.fieldKey));

  const fields = [...missing, ...doubts.map((d) => d.fieldKey)].slice(0, MAX_ASK_ITEMS);

  // Only doubts carry a value: a missing field has nothing to show.
  const knownValues: Record<string, string> = {};
  for (const d of doubts) {
    if (fields.includes(d.fieldKey) && d.proposedValue) {
      knownValues[d.fieldKey] = d.proposedValue;
    }
  }

  return { fields, knownValues };
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

  const confidenceOf = (key: string) =>
    extracted.find((f) => canonicalFieldKey(f.field_key) === canonicalFieldKey(key))
      ?.confidence;

  for (const rawKey of uncertainKeys) {
    if (!isWorthConfirming(rawKey)) continue;
    // Worked out from something we already read well — an analyst can correct
    // it without costing the claimant an email.
    if (isDerivable(rawKey, confidenceOf)) continue;

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

/** Whether anything has already gone out to the claimant on this case. */
async function hasPriorOutbound(caseId: string, tenantId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.case_id, caseId),
          eq(outboundMessages.tenant_id, tenantId)
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    // Fall back to the first-contact wording: greeting someone twice is a
    // smaller error than closing a conversation that never happened.
    console.error("[orchestrate] Failed to check prior outbound:", errCode(err));
    return false;
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
