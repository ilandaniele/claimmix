/**
 * AI extraction worker — orchestrates the full extraction pipeline.
 *
 * Original pipeline (simulate flow — still active):
 *   1. Check budget (LLM10)
 *   2. Select extractor: mock vs OpenAI (based on MOCK_AI env or key presence)
 *   3. Run extractor → ExtractedClaim
 *   4. Gap analysis → recommended_status + missing_doc_keys
 *   5. Write extracted_fields to DB (service role)
 *   6. Write missing_docs to DB (if any)
 *   7. FSM transition: procesando → listo|esperando|escalado
 *   8. Update case.status + case.confidence_min
 *   9. Write audit_log
 *   10. Record ai_usage
 *   11. Create outbound_messages stub (if esperando)
 *
 * Email intake pipeline extension (W3 — runExtractionWorker with email flow):
 *   a. Fetch case + raw_messages (most recent)
 *   b. Load memory hints from claim_memory for this sender (AC13 groundwork)
 *   c. Load known_claim_patterns for this tenant
 *   d. Run extractEmailClaim() (or mock if AI_MOCK=true)
 *   e. classifySeverity() — two-layer (pattern + AI)
 *   f. findCustomerMatches() with extracted fields
 *   g. findPolicyMatches() with extracted policy_number + matched customer
 *   h. Persist results:
 *      - is_claim=false → status='no_relevante', not_relevant_reason set (AC5)
 *      - is_claim=true  → extracted_fields, missing_docs, severity, customer_id, policy_id
 *   i. If severity=high/critical → requires_specialist=true, status='requiere_especialista' (AC11)
 *   j. Log MEMORY_APPLIED if memory hints were used (AC13 groundwork)
 *   k. Log EXTRACTION_COMPLETE
 *
 * LLM07: Service role client used for all DB writes — never anon key.
 * LLM08: The LLM cannot set case.status. FSM transition is code-enforced.
 * AC17: Prompt injection in email cannot change case.status (FSM containment).
 * AC18: Only case_id + model + token counts logged — never raw_intake_text.
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { analyzeGaps } from "@/server/ai/gap-analysis";
import { checkBudget, recordUsage } from "@/server/ai/budget";
import { runMockExtractor, extractEmailClaimMock } from "@/server/ai/mock-extractor";
import { runOpenAIExtractor, extractEmailClaim, OpenAIExtractionError } from "@/server/ai/openai-extractor";
import { classifySeverity, requiresSpecialist } from "@/server/ai/severity-classifier";
import { findCustomerMatches } from "@/server/matching/customer-matcher";
import { findPolicyMatches } from "@/server/matching/policy-matcher";
import { isValidTransition } from "@/server/cases/fsm";
import { orchestratePostExtraction } from "@/server/confirmations/orchestrate";
import { hydrateFieldsFromExtracted, scrubPiiFromSummary } from "@/server/ai/hydrate-fields";
import { ClaimTypeSchema } from "@/lib/schemas/cases";
import type { ClaimType } from "@/lib/schemas/cases";
import type { KnownPattern } from "@/server/ai/prompt";

/** Determine whether to use mock mode. */
function shouldUseMock(): boolean {
  return (
    process.env.MOCK_AI === "true" ||
    process.env.AI_MOCK === "true" ||
    !process.env.OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY.trim() === ""
  );
}

/**
 * Run the extraction worker for a case in "procesando" status.
 * This is the LEGACY worker for the simulate flow (email_sim cases).
 *
 * Safe to call fire-and-forget (all errors are caught and logged).
 * Status transitions are contained to: procesando → listo|esperando|escalado.
 */
export async function runExtractionWorker(
  caseId: string,
  tenantId: string,
  userId: string | null
): Promise<void> {
  const supabase = createServiceClient();

  // ── 0. Fetch case + raw message ──────────────────────────────────────────────

  const { data: caseRow, error: caseError } = await (supabase as any)
    .from("cases")
    .select("id,status,claim_type,tenant_id,channel")
    .eq("id", caseId)
    .eq("tenant_id", tenantId)
    .single();

  if (caseError || !caseRow) {
    console.error("[worker] Case not found:", caseId, caseError?.code);
    return;
  }

  // Route to email intake worker for real email cases.
  if (caseRow.channel === "email") {
    await runEmailExtractionWorker(caseId, tenantId, userId);
    return;
  }

  if (caseRow.status !== "procesando") {
    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "worker.skipped.not_procesando",
        case_id: caseId,
        status: caseRow.status,
      })
    );
    return;
  }

  const claimType = caseRow.claim_type as ClaimType;

  // Fetch raw message body.

  const { data: rawMsg, error: rawError } = await (supabase as any)
    .from("raw_messages")
    .select("body")
    .eq("case_id", caseId)
    .order("received_at", { ascending: false })
    .limit(1)
    .single();

  if (rawError || !rawMsg) {
    console.error("[worker] Raw message not found for case:", caseId, rawError?.code);
    await escalateCase(supabase, caseId, tenantId, userId, "raw_message_missing", "raw_message_missing");
    return;
  }

  // ── 1. Budget check ──────────────────────────────────────────────────────────
  const budgetResult = await checkBudget(tenantId, userId);
  if (budgetResult.exceeded) {
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "claimmix",
        msg: "worker.budget_exceeded",
        case_id: caseId,
        reason: budgetResult.reason,
      })
    );
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userId,
      event_type: AuditEvent.AI_BUDGET_EXCEEDED,
      target_type: "case",
      target_id: caseId,
      payload: { reason: budgetResult.reason },
    });
    // Park case in escalado — human needs to re-trigger.
    await updateCaseStatus(supabase, caseId, tenantId, "escalado", null);
    return;
  }

  // ── 2. Select and run extractor ──────────────────────────────────────────────
  const useMock = shouldUseMock();
  let extractedClaim;

  try {
    if (useMock) {
      extractedClaim = runMockExtractor(rawMsg.body, claimType);
    } else {
      extractedClaim = await runOpenAIExtractor(rawMsg.body, claimType, caseId);
    }
  } catch (e) {
    if (e instanceof OpenAIExtractionError) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: "worker.ai_output_invalid",
          case_id: caseId,
          error_name: e.name,
        })
      );
      await escalateCase(supabase, caseId, tenantId, userId, "AI_OUTPUT_INVALID", "ai_output_invalid");
      return;
    }
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "worker.extractor_error",
        case_id: caseId,
        error_name: name,
      })
    );
    await escalateCase(supabase, caseId, tenantId, userId, "extractor_error", "extractor_error");
    return;
  }

  // ── 3. Gap analysis ──────────────────────────────────────────────────────────
  const gapResult = analyzeGaps(claimType, extractedClaim.fields);

  // ── 4. Write extracted_fields ────────────────────────────────────────────────
  if (extractedClaim.fields.length > 0) {
    const fieldInserts = extractedClaim.fields.map((f) => ({
      case_id: caseId,
      tenant_id: tenantId,
      field_key: f.field_key,
      field_value: f.field_value,
      confidence: parseFloat(f.confidence.toFixed(2)),
    }));


    const { error: fieldsError } = await (supabase as any)
      .from("extracted_fields")
      .upsert(fieldInserts, { onConflict: "case_id,field_key" });

    if (fieldsError) {
      console.error("[worker] Failed to write extracted_fields:", fieldsError.code, "case:", caseId);
    }
  }

  // ── 5. Write missing_docs ────────────────────────────────────────────────────
  if (gapResult.missing_doc_keys.length > 0) {
    const now = new Date().toISOString();
    const missingInserts = gapResult.missing_doc_keys.map((docKey) => ({
      case_id: caseId,
      tenant_id: tenantId,
      doc_key: docKey,
      requested_at: null,
      satisfied_at: null,
    }));


    const { error: missingError } = await (supabase as any)
      .from("missing_docs")
      .upsert(missingInserts, { onConflict: "case_id,doc_key" });

    if (missingError) {
      console.error("[worker] Failed to write missing_docs:", missingError.code, "case:", caseId);
    }

    // Create outbound_messages stub (AC6).

    const { error: outboundError } = await (supabase as any).from("outbound_messages").insert({
      case_id: caseId,
      tenant_id: tenantId,
      channel: "email_sim",
      template: "request_missing_docs",
      rendered_body: `Se solicita la documentación faltante para el caso ${caseId}: ${gapResult.missing_doc_keys.join(", ")}`,
      status: "queued",
    });
    void now; // suppress unused var lint
    if (outboundError) {
      console.error("[worker] Failed to create outbound_messages:", outboundError.code);
    }
  }

  // ── 6. FSM transition: procesando → new_status ───────────────────────────────
  const newStatus = gapResult.recommended_status;

  // Safety: always validate FSM transition (LLM08 containment).
  if (!isValidTransition("procesando", newStatus)) {
    console.error("[worker] Invalid FSM transition attempt:", "procesando", "→", newStatus);
    await escalateCase(supabase, caseId, tenantId, userId, "fsm_violation", "fsm_violation");
    return;
  }

  // ── 7. Update case status + confidence_min ───────────────────────────────────
  await updateCaseStatus(supabase, caseId, tenantId, newStatus, gapResult.confidence_min);

  // ── 8. Audit log ─────────────────────────────────────────────────────────────
  const auditPayload: Record<string, unknown> = {
    model: extractedClaim.extraction_model,
    fields_extracted: extractedClaim.fields.length,
    confidence_min: gapResult.confidence_min,
    new_status: newStatus,
    missing_doc_keys: gapResult.missing_doc_keys,
  };

  if (gapResult.low_confidence_fields.length > 0) {
    auditPayload.reason = "low_confidence";
    auditPayload.low_confidence_fields = gapResult.low_confidence_fields;
  }

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.AI_EXTRACTED,
    target_type: "case",
    target_id: caseId,
    payload: auditPayload,
  });

  // ── 9. Record AI usage (budget tracking) ─────────────────────────────────────
  if (extractedClaim.prompt_tokens > 0 || extractedClaim.completion_tokens > 0) {
    await recordUsage(
      tenantId,
      userId,
      extractedClaim.extraction_model,
      extractedClaim.prompt_tokens,
      extractedClaim.completion_tokens,
      extractedClaim.cost_usd
    );
  }

  // LLM06: Log only safe metadata — never raw_intake_text.
  console.info(
    JSON.stringify({
      level: "info",
      service: "claimmix",
      msg: "worker.extraction_complete",
      case_id: caseId,
      model: extractedClaim.extraction_model,
      prompt_tokens: extractedClaim.prompt_tokens,
      completion_tokens: extractedClaim.completion_tokens,
      new_status: newStatus,
      confidence_min: gapResult.confidence_min,
      missing_docs_count: gapResult.missing_doc_keys.length,
    })
  );
}

// ── Email intake extraction worker ─────────────────────────────────────────────

/**
 * Run the extraction worker for a real email case (channel='email').
 *
 * This is the W3 pipeline for email-sourced cases. Called from the webhook handler
 * via runExtractionWorker when channel='email', or directly via the API route
 * POST /api/worker/extract.
 *
 * Pipeline:
 *   a) Fetch case + raw_messages (most recent)
 *   b) Load memory hints from claim_memory for this sender
 *   c) Load known_claim_patterns for this tenant
 *   d) Run extractEmailClaim() (or mock)
 *   e) classifySeverity() — two-layer
 *   f) findCustomerMatches()
 *   g) findPolicyMatches()
 *   h) Persist results
 *   i) Specialist escalation if high/critical
 *   j) Memory applied audit log
 *
 * AC5:  is_claim=false → status='no_relevante'
 * AC6:  Single high-confidence match → set customer_id + policy_id
 * AC8:  Low-confidence fields → missing_docs rows (not in extracted_fields)
 * AC11: severity=high/critical → requires_specialist=true + status='requiere_especialista'
 * AC13: Memory hints injected into prompt (groundwork — W5 completes full recall)
 * AC15: Severity classification matrix enforced by classifySeverity()
 * AC25: XML sentinel delimiters in buildEmailClaimPrompt defuse injection
 */
export async function runEmailExtractionWorker(
  caseId: string,
  tenantId: string,
  userId: string | null
): Promise<void> {
  const supabase = createServiceClient();

  try {
    // ── a) Fetch case + raw_messages ──────────────────────────────────────────

    const { data: caseRow, error: caseError } = await (supabase as any)
      .from("cases")
      .select("id,status,claim_type,tenant_id,channel,email_thread_id,policyholder_name,policy_number")
      .eq("id", caseId)
      .eq("tenant_id", tenantId)
      .single();

    if (caseError || !caseRow) {
      console.error("[email-worker] Case not found:", caseId, caseError?.code);
      return;
    }

    // Only process cases in 'recibido' status (or legacy 'procesando' for compat).
    const allowedStartStatuses = ["recibido", "procesando", "info_faltante"];
    if (!allowedStartStatuses.includes(caseRow.status)) {
      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: "email_worker.skipped.wrong_status",
          case_id: caseId,
          status: caseRow.status,
        })
      );
      return;
    }

    // Fetch message body — try raw_messages (simulate flow) first, then
    // claim_messages (Gmail intake flow). Gmail cases write to claim_messages only.

    let emailBody = "";
    let emailSubject = "";
    let senderEmail = "";

    const { data: rawMsg, error: rawError } = await (supabase as any)
      .from("raw_messages")
      .select("body,subject,from_addr")
      .eq("case_id", caseId)
      .order("received_at", { ascending: false })
      .limit(1)
      .single();

    if (rawMsg && !rawError) {
      emailBody = rawMsg.body ?? "";
      emailSubject = rawMsg.subject ?? "";
      senderEmail = rawMsg.from_addr ?? "";
    } else {
      // Fallback: Gmail intake cases store messages in claim_messages.
      const { data: claimMsg, error: claimError } = await (supabase as any)
        .from("claim_messages")
        .select("body_text,subject,from_addr")
        .eq("case_id", caseId)
        .eq("direction", "inbound")
        .order("received_at", { ascending: false })
        .limit(1)
        .single();

      if (claimError || !claimMsg) {
        console.error("[email-worker] Raw message not found:", caseId, claimError?.code); // crew-debug-ok
        return;
      }

      emailBody = claimMsg.body_text ?? "";
      emailSubject = claimMsg.subject ?? "";
      senderEmail = claimMsg.from_addr ?? "";
    }

    // ── b) Load memory hints from claim_memory ───────────────────────────────
    const memoryHints = await loadMemoryHints(supabase, tenantId, senderEmail);
    const memoryApplied = memoryHints.length > 0;

    // ── c) Load known_claim_patterns ─────────────────────────────────────────
    const knownPatterns = await loadKnownPatterns(supabase, tenantId);

    // ── d) Budget check ───────────────────────────────────────────────────────
    const budgetResult = await checkBudget(tenantId, userId);
    if (budgetResult.exceeded) {
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "claimmix",
          msg: "email_worker.budget_exceeded",
          case_id: caseId,
          reason: budgetResult.reason,
        })
      );
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: userId,
        event_type: AuditEvent.AI_BUDGET_EXCEEDED,
        target_type: "case",
        target_id: caseId,
        payload: { reason: budgetResult.reason },
      });
      return;
    }

    // ── e) Run extractor ──────────────────────────────────────────────────────
    const useMock = shouldUseMock();
    let extractedClaim;

    if (useMock) {
      extractedClaim = extractEmailClaimMock();
    } else {
      extractedClaim = await extractEmailClaim(
        {
          subject: emailSubject,
          body: emailBody,
          memoryHints,
          knownPatterns,
          senderEmail,
        },
        tenantId,
        caseId
      );
    }

    // ── e2) Defensive hydration: mirror typed extracted_fields into fields[] + scrub PII ──
    // This is a defensive layer — the primary fix is in the prompt (RULE D / RULE F).
    // Ensures fields[] is always the source of truth for DB writes, even if the model
    // populates only one of the two shapes.
    extractedClaim = {
      ...scrubPiiFromSummary(extractedClaim),
      fields: hydrateFieldsFromExtracted(extractedClaim),
    };

    // ── f) Classify severity — two-layer (pattern + AI) ──────────────────────
    const fullText = `${emailSubject}\n\n${emailBody}`;
    const finalSeverity = classifySeverity(
      fullText,
      extractedClaim.severity,
      knownPatterns
    );
    const needsSpecialist = requiresSpecialist(finalSeverity);

    // ── g) Handle is_claim=false — AC5 ───────────────────────────────────────
    if (extractedClaim.is_claim === false) {
      const reason =
        extractedClaim.not_relevant_reason ||
        "El clasificador de IA determinó que este email no es un reclamo de seguro.";

      await (supabase as any)
        .from("cases")
        .update({
          status: "no_relevante",
          is_claim: false,
          not_relevant_reason: reason.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("id", caseId);

      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: userId,
        event_type: AuditEvent.EXTRACTION_COMPLETE,
        target_type: "case",
        target_id: caseId,
        payload: {
          is_claim: false,
          model: extractedClaim.extraction_model,
          new_status: "no_relevante",
        },
      });

      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: "email_worker.not_relevant",
          case_id: caseId,
        })
      );
      return;
    }

    // ── h) is_claim=true — persist extracted fields ───────────────────────────

    // Write extracted_fields for fields with confidence ≥ 0.60 (AC8).
    const HIGH_CONFIDENCE_THRESHOLD = 0.60;
    const fieldsToWrite = extractedClaim.fields.filter(
      (f) => f.confidence >= HIGH_CONFIDENCE_THRESHOLD
    );
    const lowConfidenceFields = extractedClaim.fields.filter(
      (f) => f.confidence < HIGH_CONFIDENCE_THRESHOLD
    );

    if (fieldsToWrite.length > 0) {
      const fieldInserts = fieldsToWrite.map((f) => ({
        case_id: caseId,
        tenant_id: tenantId,
        field_key: f.field_key,
        field_value: f.field_value,
        confidence: parseFloat(f.confidence.toFixed(2)),
      }));


      const { error: fieldsError } = await (supabase as any)
        .from("extracted_fields")
        .upsert(fieldInserts, { onConflict: "case_id,field_key" });

      if (fieldsError) {
        console.error("[email-worker] extracted_fields upsert error:", fieldsError.code);
      }
    }

    // Write missing_docs for fields with confidence < 0.60 (AC8).
    // Also include explicit missing_fields from extractor output.
    const missingFieldKeys = [
      ...new Set([
        ...lowConfidenceFields.map((f) => f.field_key),
        ...(extractedClaim.missing_fields ?? []),
      ]),
    ];

    if (missingFieldKeys.length > 0) {
      const missingInserts = missingFieldKeys.map((docKey) => ({
        case_id: caseId,
        tenant_id: tenantId,
        doc_key: docKey,
        requested_at: null,
        satisfied_at: null,
      }));


      const { error: missingError } = await (supabase as any)
        .from("missing_docs")
        .upsert(missingInserts, { onConflict: "case_id,doc_key" });

      if (missingError) {
        console.error("[email-worker] missing_docs upsert error:", missingError.code);
      }
    }

    // ── i) Customer matching — AC6, AC22 ─────────────────────────────────────
    // Build from fields array first (always present), then overlay with
    // extracted_fields typed object (may be absent if OpenAI omitted it).
    const extractedClaimFields: Record<string, string | undefined> = Object.fromEntries(
      extractedClaim.fields.map((f) => [f.field_key, f.field_value])
    );
    if (extractedClaim.extracted_fields) {
      const ef = extractedClaim.extracted_fields;
      if (ef.full_name)            extractedClaimFields.full_name = ef.full_name;
      if (ef.email)                extractedClaimFields.email = ef.email;
      if (ef.phone)                extractedClaimFields.phone = ef.phone;
      if (ef.dni)                  extractedClaimFields.dni = ef.dni;
      if (ef.policy_number)        extractedClaimFields.policy_number = ef.policy_number;
      if (ef.accident_date)        extractedClaimFields.accident_date = ef.accident_date;
      if (ef.accident_location)    extractedClaimFields.accident_location = ef.accident_location;
      if (ef.accident_description) extractedClaimFields.accident_description = ef.accident_description;
      if (ef.claim_type)           extractedClaimFields.claim_type = ef.claim_type;
    }
    const customerMatches = await findCustomerMatches(
      supabase,
      tenantId,
      extractedClaimFields
    );

    // Use the highest-confidence customer match for the case.
    const bestCustomer = customerMatches[0];
    let resolvedCustomerId: string | undefined = bestCustomer?.customerId;
    let resolvedPolicyId: string | undefined = bestCustomer?.policyId;

    // ── j) Policy matching ────────────────────────────────────────────────────
    const policyNumber = extractedClaimFields.policy_number;
    const policyMatches = await findPolicyMatches(
      supabase,
      tenantId,
      policyNumber,
      resolvedCustomerId
    );

    if (!resolvedPolicyId && policyMatches.length > 0) {
      resolvedPolicyId = policyMatches[0]?.policyId;
    }

    // ── k) Determine final case status ────────────────────────────────────────
    let newStatus: string;

    if (needsSpecialist) {
      // AC11: High/critical severity → specialist escalation.
      newStatus = "requiere_especialista";
    } else if (missingFieldKeys.length > 0) {
      newStatus = "info_faltante";
    } else if ((extractedClaim.fields_pending_confirmation ?? []).length > 0) {
      newStatus = "confirmacion_pendiente";
    } else {
      // All fields present at high confidence — ready for review.
      newStatus = "listo";
    }

    // FSM safety check (LLM08).
    // The recibido status is the starting point for email cases — no transition needed
    // if we're moving from recibido to another status.
    // For cases coming from info_faltante (thread reply), validate the transition.
    const currentStatus = caseRow.status as string;
    const isValidNewStatus = currentStatus === "recibido" ||
      isValidTransition(currentStatus as any, newStatus as any);

    if (!isValidNewStatus && currentStatus !== newStatus) {
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "claimmix",
          msg: "email_worker.fsm_transition_skipped",
          case_id: caseId,
          from: currentStatus,
          to: newStatus,
        })
      );
      // Keep current status — do not violate FSM.
      newStatus = currentStatus;
    }

    // ── l) Update case row ────────────────────────────────────────────────────
    const caseUpdate: Record<string, unknown> = {
      is_claim: true,
      severity: finalSeverity,
      requires_specialist: needsSpecialist,
      status: newStatus,
      updated_at: new Date().toISOString(),
    };

    if (resolvedCustomerId) {
      caseUpdate.customer_id = resolvedCustomerId;
    }
    if (resolvedPolicyId) {
      caseUpdate.policy_id = resolvedPolicyId;
    }

    // Copy policyholder identity fields from extraction to the cases row so the
    // detail page can display them even before customer matching succeeds.
    // Only write when the column is still null — never overwrite analyst-confirmed data.
    const extractedFullName = extractedClaimFields.full_name;
    const extractedPolicyNumber = extractedClaimFields.policy_number;
    if (!caseRow.policyholder_name && extractedFullName && typeof extractedFullName === "string" && extractedFullName.trim()) {
      caseUpdate.policyholder_name = extractedFullName.trim().slice(0, 200);
    }
    if (!caseRow.policy_number && extractedPolicyNumber && typeof extractedPolicyNumber === "string" && extractedPolicyNumber.trim()) {
      caseUpdate.policy_number = extractedPolicyNumber.trim().slice(0, 100);
    }

    // ── claim_type: write AI-returned value when valid — AC1, AC2, AC3, AC4 ────
    // The AI extractor returns claim_type in extracted_fields.claim_type.
    // Also check the fields array (field_key="claim_type") as a fallback.
    const rawClaimType =
      extractedClaimFields.claim_type ??
      extractedClaim.fields.find((f) => f.field_key === "claim_type")?.field_value;

    if (rawClaimType !== null && rawClaimType !== undefined && typeof rawClaimType === "string" && rawClaimType.trim() !== "") {
      const claimTypeParsed = ClaimTypeSchema.safeParse(rawClaimType.trim());
      if (claimTypeParsed.success) {
        // AC1: write valid claim_type; AC2: "other" works; AC4: same value is idempotent
        caseUpdate.claim_type = claimTypeParsed.data;
      } else {
        // AC3 variant: AI returned a non-null but invalid value — skip, warn, don't throw
        console.warn(
          JSON.stringify({
            level: "warn",
            service: "claimmix",
            msg: "email_worker.claim_type_invalid",
            case_id: caseId,
            raw_value: rawClaimType.trim().slice(0, 50),
          })
        );
      }
    }
    // AC3: AI omitted claim_type (null/undefined/empty) → caseUpdate has no claim_type key
    // → existing cases.claim_type is preserved (no overwrite).

    const { error: caseUpdateError } = await (supabase as any)
      .from("cases")
      .update(caseUpdate)
      .eq("id", caseId);

    if (caseUpdateError) {
      console.error("[email-worker] Case update error:", caseUpdateError.code);
    }

    // ── m) Specialist audit log — AC11 ────────────────────────────────────────
    if (needsSpecialist) {
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: userId,
        event_type: AuditEvent.SPECIALIST_REQUIRED,
        target_type: "case",
        target_id: caseId,
        payload: { severity: finalSeverity },
      });
    }

    // ── n) Memory applied audit log — AC13 groundwork ────────────────────────
    if (memoryApplied) {
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: userId,
        event_type: AuditEvent.MEMORY_APPLIED,
        target_type: "case",
        target_id: caseId,
        payload: {
          fields_applied: memoryHints.map((h) => h.field_key),
          // PII: sender email is NOT logged here
        },
      });
    }

    // ── n2) Post-extraction orchestration — W4 ────────────────────────────────
    // Decides what confirmation/missing-info/specialist emails to send and
    // what final status to apply, based on the extraction result.
    // AC7, AC9, AC10, AC11, AC12.
    await orchestratePostExtraction(
      supabase,
      caseId,
      tenantId,
      {
        extractedClaim,
        senderEmail,
        // inReplyToMessageId: not available here; looked up by dispatch from
        // the raw_messages row if needed. Passed as undefined — dispatch
        // degrades gracefully (no In-Reply-To header on first send).
        inReplyToMessageId: undefined,
      },
      customerMatches
    );

    // ── o) Extraction complete audit log ──────────────────────────────────────
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userId,
      event_type: AuditEvent.EXTRACTION_COMPLETE,
      target_type: "case",
      target_id: caseId,
      payload: {
        is_claim: true,
        model: extractedClaim.extraction_model,
        severity: finalSeverity,
        new_status: newStatus,
        claim_type: (caseUpdate.claim_type as string | undefined) ?? null,
        missing_fields: missingFieldKeys,
        customer_matched: !!resolvedCustomerId,
        policy_matched: !!resolvedPolicyId,
        prompt_tokens: extractedClaim.prompt_tokens,
        completion_tokens: extractedClaim.completion_tokens,
      },
    });

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "email_worker.extraction_complete",
        case_id: caseId,
        is_claim: true,
        severity: finalSeverity,
        new_status: newStatus,
        customer_matched: !!resolvedCustomerId,
        policy_matched: !!resolvedPolicyId,
        missing_fields_count: missingFieldKeys.length,
        model: extractedClaim.extraction_model,
      })
    );
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "email_worker.unhandled_error",
        case_id: caseId,
        error_name: errName,
      })
    );
    // Do not rethrow — fire-and-forget callers must not crash.
  }
}

// ── Helper: load memory hints ─────────────────────────────────────────────────

async function loadMemoryHints(
  supabase: ReturnType<typeof createServiceClient>,
  tenantId: string,
  senderEmail: string
): Promise<Array<{ field_key: string; value: string; confirmed_at?: string }>> {
  if (!senderEmail) return [];

  try {

    const { data, error } = await (supabase as any)
      .from("claim_memory")
      .select("confirmed_fields,full_name,dni,phone,default_policy_number")
      .eq("tenant_id", tenantId)
      .eq("sender_email", senderEmail)
      .limit(1)
      .single();

    if (error || !data) return [];

    const hints: Array<{ field_key: string; value: string; confirmed_at?: string }> = [];

    // Extract confirmed fields (jsonb object: { field_key: { value, confirmed_at } }).
    const confirmedFields = data.confirmed_fields as Record<string, { value: string; confirmed_at?: string }> | null;
    if (confirmedFields) {
      for (const [key, entry] of Object.entries(confirmedFields)) {
        if (entry?.value) {
          hints.push({ field_key: key, value: entry.value, confirmed_at: entry.confirmed_at });
        }
      }
    }

    // Also add flat columns as hints.
    if (data.full_name) hints.push({ field_key: "full_name", value: data.full_name });
    if (data.dni)       hints.push({ field_key: "dni",       value: data.dni });
    if (data.phone)     hints.push({ field_key: "phone",     value: data.phone });
    if (data.default_policy_number) {
      hints.push({ field_key: "policy_number", value: data.default_policy_number });
    }

    // Deduplicate by field_key (confirmed_fields takes priority).
    const seen = new Set<string>();
    return hints.filter((h) => {
      if (seen.has(h.field_key)) return false;
      seen.add(h.field_key);
      return true;
    });
  } catch {
    return [];
  }
}

// ── Helper: load known_claim_patterns ────────────────────────────────────────

async function loadKnownPatterns(
  supabase: ReturnType<typeof createServiceClient>,
  tenantId: string
): Promise<KnownPattern[]> {
  try {

    const { data, error } = await (supabase as any)
      .from("known_claim_patterns")
      .select("pattern_text,pattern_type,severity_hint,language")
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
      .eq("enabled", true)
      .limit(200);

    if (error) {
      console.error("[email-worker] known_claim_patterns load error:", error.code);
      return [];
    }

    return (data ?? []).map((row: any) => ({
      pattern_text: row.pattern_text ?? "",
      pattern_type: row.pattern_type ?? "keyword",
      severity_hint: row.severity_hint ?? "medium",
      language: row.language ?? "es-AR",
    }));
  } catch {
    return [];
  }
}

// ── Helpers (shared with legacy worker) ───────────────────────────────────────

async function updateCaseStatus(
  supabase: ReturnType<typeof createServiceClient>,
  caseId: string,
  _tenantId: string,
  newStatus: "listo" | "esperando" | "escalado",
  confidenceMin: number | null
): Promise<void> {
  const updatePayload: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
  if (confidenceMin !== null) {
    updatePayload.confidence_min = confidenceMin;
  }


  const { error } = await (supabase as any)
    .from("cases")
    .update(updatePayload)
    .eq("id", caseId);

  if (error) {
    console.error("[worker] Failed to update case status:", error.code, "case:", caseId);
  }
}

async function escalateCase(
  supabase: ReturnType<typeof createServiceClient>,
  caseId: string,
  tenantId: string,
  userId: string | null,
  auditReason: string,
  errorCode: string
): Promise<void> {
  await updateCaseStatus(supabase, caseId, tenantId, "escalado", null);
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.AI_EXTRACTED,
    target_type: "case",
    target_id: caseId,
    payload: {
      new_status: "escalado",
      reason: auditReason,
      error_code: errorCode,
    },
  });
}
