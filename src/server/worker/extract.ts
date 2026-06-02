/**
 * AI extraction worker — orchestrates the full extraction pipeline.
 *
 * Pipeline:
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
 * LLM07: Service role client used for all DB writes — never anon key.
 * LLM08: The LLM cannot set case.status. FSM transition is code-enforced:
 *         procesando → listo | esperando | escalado (never cerrado).
 * AC17: Prompt injection in email cannot change case.status (FSM containment).
 * AC18: Only case_id + model + token counts logged — never raw_intake_text.
 *
 * @param caseId    - UUID of the case to process.
 * @param tenantId  - Tenant ID (for budget checks and service role writes).
 * @param userId    - User who triggered the extraction (nullable for system).
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { analyzeGaps } from "@/server/ai/gap-analysis";
import { checkBudget, recordUsage } from "@/server/ai/budget";
import { runMockExtractor } from "@/server/ai/mock-extractor";
import { runOpenAIExtractor, OpenAIExtractionError } from "@/server/ai/openai-extractor";
import { isValidTransition } from "@/server/cases/fsm";
import type { ClaimType } from "@/lib/schemas/cases";

/** Determine whether to use mock mode. */
function shouldUseMock(): boolean {
  return (
    process.env.MOCK_AI === "true" ||
    !process.env.OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY.trim() === ""
  );
}

/**
 * Run the extraction worker for a case in "procesando" status.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: caseRow, error: caseError } = await (supabase as any)
    .from("cases")
    .select("id,status,claim_type,tenant_id")
    .eq("id", caseId)
    .eq("tenant_id", tenantId)
    .single();

  if (caseError || !caseRow) {
    console.error("[worker] Case not found:", caseId, caseError?.code);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: missingError } = await (supabase as any)
      .from("missing_docs")
      .upsert(missingInserts, { onConflict: "case_id,doc_key" });

    if (missingError) {
      console.error("[worker] Failed to write missing_docs:", missingError.code, "case:", caseId);
    }

    // Create outbound_messages stub (AC6).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ── Helpers ────────────────────────────────────────────────────────────────────

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
