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
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { enTenant, enTenantVarias, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import {
  cases,
  claimMessages,
  extractedFields,
  knownClaimPatterns,
  missingDocs,
  outboundMessages,
  rawMessages,
} from "@/lib/db/schema";
import type { CaseInsert } from "@/lib/db/types";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { analyzeGaps, UMBRAL_POR_OMISION } from "@/core/case/gap-analysis";
import { checkBudget, recordUsage } from "@/server/ai/budget";
import { ClaimAgentError, runClaimTextAgent, runEmailClaimAgent } from "@/server/ai/claim-agent";
import { GeminiExtractionError } from "@/server/ai/gemini-extractor";
import { classifySeverity, requiresSpecialist } from "@/server/ai/severity-classifier";
import { findCustomerMatches } from "@/server/matching/customer-matcher";
import { findPolicyMatches } from "@/server/matching/policy-matcher";
import { isValidTransition } from "@/core/case/fsm";
import {
  estadoTrasExtraer,
  sePuedeTransicionar,
} from "@/core/case/status-after-extraction";
import { CLAIM_FIELD_KEYS } from "@/lib/schemas/extracted-claim";
import { getWorkerBaseUrl } from "@/server/email/dispatch-url";
import { internalAuthHeaders } from "@/lib/security/internal-auth";
import { orchestratePostExtraction } from "@/server/confirmations/orchestrate";
import { messengerFor } from "@/server/confirmations/messenger";
import { loadAgentTraining } from "@/server/agents/training";
import { loadActivePromptRules, formatPromptRules } from "@/server/training/prompt-rules";
import { loadApprovedExamples, formatApprovedExamples } from "@/server/training/examples";
import { loadActiveCustomFields, formatCustomFields } from "@/server/training/custom-fields";
import { getActivePromptVersion } from "@/server/training/prompt-version";
import { assessTrainability } from "@/server/training/trainability";
import { logAgentRun, logAgentRunError } from "@/server/training/agent-runs";
import { loadMemoryHints as loadClaimMemoryHints } from "@/server/memory/load";
import { hydrateFieldsFromExtracted, scrubPiiFromSummary } from "@/server/ai/hydrate-fields";
import { ClaimTypeSchema } from "@/lib/schemas/cases";
import { waitForEmailExtractionTurn } from "@/server/intake/simulation-throttle";
import { mergeExtractedFields, parseEmailClaimFields } from "@/lib/email/claim-parser";
import type { ClaimType } from "@/lib/schemas/cases";
import type { KnownPattern } from "@/server/ai/prompt";
import { stripQuotedReply, buildConversationBody } from "@/core/email/conversation";


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
  // El contexto se arma una vez, acá, a partir del inquilino que llega en la
  // firma. Todo lo que consulte o escriba abajo lo recibe: esa es la única
  // forma de que la base sepa de quién es lo que se está tocando.
  const tenantCtx: TenantContext = { tenantId };
  // ──0. Fetch case + raw message ──────────────────────────────────────────────

  let caseRow: {
    id: string;
    status: string;
    claim_type: string | null;
    tenant_id: string;
    channel: string;
  } | null;
  try {
    caseRow = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({
            id: cases.id,
            status: cases.status,
            claim_type: cases.claim_type,
            tenant_id: cases.tenant_id,
            channel: cases.channel,
          })
          .from(cases)
          .where(eq(cases.id, caseId))
          .limit(1)
      )
    );
  } catch (err) {
    console.error("[worker] Case not found:", caseId, dbErrCode(err));
    return;
  }

  if (!caseRow) {
    console.error("[worker] Case not found:", caseId);
    return;
  }

  // Route supported intake channels to the modern worker so every run is logged.
  if (
    caseRow.channel === "email" ||
    caseRow.channel === "email_sim" ||
    caseRow.channel === "whatsapp" ||
    caseRow.channel === "whatsapp_sim"
  ) {
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

  let rawMsg: { body: string } | null;
  try {
    rawMsg = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ body: rawMessages.body })
          .from(rawMessages)
          .where(eq(rawMessages.case_id, caseId))
          .orderBy(desc(rawMessages.received_at))
          .limit(1)
      )
    );
  } catch {
    rawMsg = null;
  }

  if (!rawMsg) {
    console.error("[worker] Raw message not found for case:", caseId);
    await escalateCase(caseId, tenantCtx, userId, "raw_message_missing", "raw_message_missing");
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
    await updateCaseStatus(caseId, tenantCtx, "escalado", null);
    return;
  }

  // ── 2. Select and run extractor (per-tenant provider: openai | gemini | mock) ─
  let extractedClaim;

  try {
    extractedClaim = await runClaimTextAgent({
      rawText: rawMsg.body,
      claimType,
      caseId,
      tenantId,
      userId,
    });
  } catch (e) {
    if (e instanceof ClaimAgentError) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: "worker.ai_output_invalid",
          case_id: caseId,
          error_name: e.cause instanceof Error ? e.cause.name : e.name,
        })
      );
      await escalateCase(caseId, tenantCtx, userId, "AI_OUTPUT_INVALID", "ai_output_invalid");
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
    await escalateCase(caseId, tenantCtx, userId, "extractor_error", "extractor_error");
    return;
  }

  // ── 3. Gap analysis ──────────────────────────────────────────────────────────
  // El umbral se lee acá, en el borde, y entra al núcleo como un número.
  const umbral = Number.parseFloat(process.env.CONFIDENCE_THRESHOLD ?? "");
  const gapResult = analyzeGaps(
    claimType,
    extractedClaim.fields,
    Number.isFinite(umbral) ? umbral : UMBRAL_POR_OMISION
  );

  // ── 4. Write extracted_fields ────────────────────────────────────────────────
  if (extractedClaim.fields.length > 0) {
    try {
      await upsertExtractedFields(caseId, tenantCtx, extractedClaim.fields);
    } catch (err) {
      console.error("[worker] Failed to write extracted_fields:", dbErrCode(err), "case:", caseId);
    }
  }

  // ── 5. Write missing_docs ────────────────────────────────────────────────────
  if (gapResult.missing_doc_keys.length > 0) {
    try {
      await insertMissingDocsIfAbsent(caseId, tenantCtx, gapResult.missing_doc_keys);
    } catch (err) {
      console.error("[worker] Failed to write missing_docs:", dbErrCode(err), "case:", caseId);
    }

    // Create outbound_messages stub (AC6).
    try {
      await enTenant(tenantCtx, (db) =>
        db.insert(outboundMessages).values({
          case_id: caseId,
          tenant_id: tenantId,
          channel: "email_sim",
          template: "request_missing_docs",
          rendered_body: `Se solicita la documentación faltante para el caso ${caseId}: ${gapResult.missing_doc_keys.join(", ")}`,
          status: "queued",
        })
      );
    } catch (err) {
      console.error("[worker] Failed to create outbound_messages:", dbErrCode(err));
    }
  }

  // ── 6. FSM transition: procesando → new_status ───────────────────────────────
  const newStatus = gapResult.recommended_status;

  // Safety: always validate FSM transition (LLM08 containment).
  if (!isValidTransition("procesando", newStatus)) {
    console.error("[worker] Invalid FSM transition attempt:", "procesando", "→", newStatus);
    await escalateCase(caseId, tenantCtx, userId, "fsm_violation", "fsm_violation");
    return;
  }

  // ── 7. Update case status + confidence_min ───────────────────────────────────
  await updateCaseStatus(caseId, tenantCtx, newStatus, gapResult.confidence_min);

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

// ── Serialising extraction per case ───────────────────────────────────────────

/**
 * How long a run may hold a case before another may take it.
 *
 * Longer than any real extraction (they run 10-20s) and short enough that a
 * function evicted mid-run does not strand the case. A lease, not a lock: a
 * crash must not wedge a claim forever.
 */
const EXTRACTION_LEASE_MS = 3 * 60 * 1000;

/**
 * Take the case, or record that it needs running again.
 *
 * Two replies a second apart produced two concurrent runs on the same case.
 * Both read the conversation before either had written, so both emailed the
 * claimant asking for the policy number and DNI they had just sent — 528 ms
 * apart — and their overlapping upserts collided, leaving neither value
 * stored. The claimant answered correctly and the data disappeared.
 *
 * The UPDATE is the lock: Postgres serialises writes to the row, so exactly
 * one caller matches the free-lease predicate and gets a row back.
 */
async function acquireExtractionLease(
  caseId: string,
  tenantCtx: TenantContext
): Promise<boolean> {
  try {
    const taken = await enTenant(tenantCtx, (db) =>
      db
        .update(cases)
        .set({ extraction_lease_at: new Date().toISOString() })
        .where(
          and(
            eq(cases.id, caseId),
            or(
              isNull(cases.extraction_lease_at),
              sql`${cases.extraction_lease_at} < now() - interval '${sql.raw(String(EXTRACTION_LEASE_MS))} milliseconds'`
            )
          )
        )
        .returning({ id: cases.id })
    );

    if (taken.length > 0) return true;

    // Someone else holds it. Their run started before this message was stored,
    // so it cannot see it — flag the case so the holder runs again rather than
    // letting the message go unread.
    await enTenant(tenantCtx, (db) =>
      db
        .update(cases)
        .set({ extraction_pending: true })
        .where(eq(cases.id, caseId))
    );

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "email_worker.deferred_busy",
        case_id: caseId,
      })
    );
    return false;
  } catch (err) {
    // Never block intake on the lease itself. Running twice is the bug we are
    // fixing; not running at all is worse.
    console.error("[email-worker] lease acquire error:", dbErrCode(err));
    return true;
  }
}

/**
 * Release the case, and say whether something arrived while we held it.
 *
 * The flag is cleared here rather than by the next run, so a message that
 * arrives after this point sets it again and is not swallowed by the re-run we
 * are about to trigger.
 */
async function releaseExtractionLease(
  caseId: string,
  tenantCtx: TenantContext
): Promise<boolean> {
  try {
    // Las dos van juntas en un lote: un solo viaje, y la lectura y la escritura
    // ocurren dentro de la misma transacción. Antes eran dos idas separadas, con
    // una ventana en el medio en la que un mensaje que llegara quedaba en tierra
    // de nadie.
    const [filas] = await enTenantVarias<[Array<{ pending: boolean | null }>, unknown]>(
      tenantCtx,
      (db) => [
        db
          .select({ pending: cases.extraction_pending })
          .from(cases)
          .where(eq(cases.id, caseId))
          .limit(1),
        db
          .update(cases)
          .set({ extraction_lease_at: null, extraction_pending: false })
          .where(eq(cases.id, caseId)),
      ]
    );

    return filas[0]?.pending === true;
  } catch (err) {
    console.error("[email-worker] lease release error:", dbErrCode(err));
    return false;
  }
}

/** Re-run the worker over HTTP for a message that landed mid-run. */
async function redispatchExtraction(caseId: string, tenantId: string): Promise<void> {
  try {
    await fetch(`${getWorkerBaseUrl()}/api/worker/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalAuthHeaders() },
      body: JSON.stringify({ caseId, tenantId }),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error("[email-worker] redispatch error:", name, "case:", caseId);
  }
}

export async function runEmailExtractionWorker(
  caseId: string,
  tenantId: string,
  userId: string | null
): Promise<void> {
  // El contexto se arma una vez, acá, a partir del inquilino que llega en la
  // firma. Todo lo que consulte o escriba abajo lo recibe: esa es la única
  // forma de que la base sepa de quién es lo que se está tocando.
  const tenantCtx: TenantContext = { tenantId };
  // Declared before try so the catch block can log them if Gemini fails mid-extraction.
  let emailBody = "";
  let emailSubject = "";
  let latestInboundText = "";
  let senderEmail = "";
  let claimMessageId: string | null = null;
  let providerMessageId: string | null = null;
  let leaseHeld = false;

  try {
    // ── a) Fetch case + raw_messages ──────────────────────────────────────────

    const caseRow = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({
            id: cases.id,
            status: cases.status,
            claim_type: cases.claim_type,
            tenant_id: cases.tenant_id,
            channel: cases.channel,
            email_thread_id: cases.email_thread_id,
            is_claim: cases.is_claim,
            policyholder_name: cases.policyholder_name,
            policy_number: cases.policy_number,
            created_at: cases.created_at,
          })
          .from(cases)
          // Buscar por id sin contexto sería peor que antes: el id de un
          // caso ajeno devolvería la fila. Con la capa, la base no la
          // entrega, y por eso este bloque va envuelto y no sólo sin filtro.
          .where(eq(cases.id, caseId))
          .limit(1)
      )
    );

    if (!caseRow) {
      console.error("[email-worker] Case not found:", caseId);
      return;
    }

    // Statuses a new inbound message may re-open.
    //
    // `confirmacion_pendiente` was missing, and it is exactly the state a case
    // is in after the agent asks the claimant to confirm something. They
    // answered, the reply attached to the case — and the worker declined to
    // look at it, so the case sat waiting for a reply that had already
    // arrived. `info_faltante` was on the list, which is why the identical
    // flow worked whenever the question happened to be phrased as a gap.
    //
    // `requiere_especialista` stays off: a person owns that case and will read
    // the thread themselves. Re-extracting could also silently downgrade the
    // severity that put it there.
    const allowedStartStatuses = [
      "recibido",
      "procesando",
      "info_faltante",
      "confirmacion_pendiente",
    ];
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

    // One run per case at a time. Everything below reads the conversation and
    // writes back to it, so two runs overlapping corrupt each other.
    if (!(await acquireExtractionLease(caseId, tenantCtx))) return;
    leaseHeld = true;

    // ── Throttle real email extractions ──────────────────────────────────────
    // Prevents burst of 30+ simultaneous Gemini calls when many emails arrive
    // at once (e.g. Monday morning). Uses GEMINI_WORKER_CONCURRENCY (default 1)
    // to limit how many run in parallel. Simulation already has its own semaphore;
    // this covers channel="email" (real Gmail intake only).
    if (caseRow.channel === "email") {
      const throttle = await waitForEmailExtractionTurn({
        tenantId,
        caseId,
        caseCreatedAt: caseRow.created_at,
      });
      if (throttle.timedOut) {
        console.warn(
          JSON.stringify({
            level: "warn",
            service: "claimmix",
            msg: "email_worker.throttle_timeout",
            case_id: caseId,
            waited_ms: throttle.waitedMs,
            blockers: throttle.blockers,
          })
        );
      }
    }

    // Fetch the message body.
    //
    // claim_messages first, because that is where the CONVERSATION lives.
    // raw_messages holds one row per message and the lookup below takes only
    // the newest, which was fine when it served the simulate flow alone —
    // but WhatsApp writes to both tables, so it silently took that path and
    // every re-extraction saw a single message in isolation. A claimant sent a
    // photo, the extractor read "[Imagen adjunta sin texto]" with no context,
    // decided it was not a claim, and killed a case that was three lines from
    // complete. The conversation fix built for email never reached WhatsApp
    // because of which table each channel happens to write.
    const rawMsg = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({
            body: rawMessages.body,
            subject: rawMessages.subject,
            from_addr: rawMessages.from_addr,
          })
          .from(rawMessages)
          .where(eq(rawMessages.case_id, caseId))
          .orderBy(desc(rawMessages.received_at))
          .limit(1)
      )
    );

    const conversation = await loadInboundConversation(caseId, tenantCtx);

    if (conversation) {
      emailBody = conversation.body;
      emailSubject = conversation.subject;
      senderEmail = conversation.senderEmail;
      latestInboundText = conversation.latestText;
      claimMessageId = conversation.claimMessageId;
      providerMessageId = conversation.providerMessageId;
    } else if (rawMsg) {
      emailBody = rawMsg.body ?? "";
      emailSubject = rawMsg.subject ?? "";
      senderEmail = rawMsg.from_addr ?? "";
      latestInboundText = emailBody;
    } else {
      // Neither table has anything: the case exists but no message does.
      console.error("[email-worker] No message found for case:", caseId); // crew-debug-ok
      return;
    }

    // ── b) Load memory hints from claim_memory ───────────────────────────────
    const memoryHints = toPromptMemoryHints(
      await loadClaimMemoryHints(tenantId, senderEmail, undefined, caseId)
    );
    const memoryApplied = memoryHints.length > 0;

    // ── c) Load known_claim_patterns + operator learning context ─────────────
    // Learning context = freeform training blob + active prompt rules +
    // human-approved few-shot examples + active versioned tenant prompt.
    const [knownPatterns, agentTraining, promptRules, approvedExamples, promptVersion, customFields] =
      await Promise.all([
        loadKnownPatterns(tenantCtx),
        loadAgentTraining(tenantId),
        loadActivePromptRules(tenantId),
        loadApprovedExamples(tenantId, caseRow.claim_type),
        getActivePromptVersion(tenantId),
        loadActiveCustomFields(tenantId, caseRow.claim_type),
      ]);

    const learning = {
      rules: formatPromptRules(promptRules),
      approvedExamples: formatApprovedExamples(approvedExamples),
      tenantSystemPrompt: promptVersion.systemPrompt ?? undefined,
      customFields: formatCustomFields(customFields),
    };

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
      // Escalate so a human can re-trigger once budget resets — never leave the case in procesando.
      await enTenant(tenantCtx, (db) =>
        db
          .update(cases)
          .set({ status: "escalado", updated_at: new Date().toISOString() })
          .where(eq(cases.id, caseId))
      );
      return;
    }

    // ── e) Run extractor (per-tenant provider: openai | gemini | mock) ───────
    let extractedClaim;

    const emailPayload = {
      subject: emailSubject,
      body: emailBody,
      memoryHints,
      knownPatterns,
      senderEmail,
      agentTraining,
      learning,
    };
    extractedClaim = await runEmailClaimAgent({
      payload: emailPayload,
      tenantId,
      caseId,
      userId,
    });

    // ── e2) Defensive hydration: mirror typed extracted_fields into fields[] + scrub PII ──
    // This is a defensive layer — the primary fix is in the prompt (RULE D / RULE F).
    // Ensures fields[] is always the source of truth for DB writes, even if the model
    // populates only one of the two shapes.
    const fallbackFields = parseEmailClaimFields({
      subject: emailSubject,
      body: emailBody,
      senderEmail,
    });
    const hydratedFields = hydrateFieldsFromExtracted(extractedClaim);
    const aiClaimType =
      extractedClaim.extracted_fields?.claim_type ??
      hydratedFields.find((f) => f.field_key === "claim_type")?.field_value;
    const mergedFields = mergeExtractedFields(hydratedFields, fallbackFields);
    const mergedFieldKeys = new Set(mergedFields.map((field) => field.field_key));
    const agentRecognizedClaim =
      extractedClaim.is_claim !== false ||
      extractedClaim.confidence > 0.2 ||
      hydratedFields.length > 0 ||
      Boolean(extractedClaim.extracted_fields);

    extractedClaim = {
      ...scrubPiiFromSummary(extractedClaim),
      fields: agentRecognizedClaim ? mergedFields : hydratedFields,
      missing_fields: (extractedClaim.missing_fields ?? []).filter(
        (fieldKey) => !mergedFieldKeys.has(fieldKey)
      ),
    };

    // ── f) Classify severity — two-layer (pattern + AI) ──────────────────────
    const fullText = `${emailSubject}\n\n${emailBody}`;
    const finalSeverity = classifySeverity(
      fullText,
      extractedClaim.severity,
      knownPatterns
    );
    const needsSpecialist = requiresSpecialist(finalSeverity);

    // ── f2) Agent run logging + trainability suggestion ───────────────────────
    // EVERY processed email creates an agent_runs row (claim or not). The
    // trainability assessment is a SUGGESTION only — learning happens solely
    // through the human confirmation endpoint. Non-fatal on failure.
    const trainability = assessTrainability({
      claim: extractedClaim,
      parseFailed: extractedClaim.parse_failed === true,
      caseId,
      emailText: fullText,
    });

    await logAgentRun({
      tenantId,
      caseId,
      claimMessageId,
      providerMessageId,
      modelName: extractedClaim.extraction_model,
      promptVersionId: promptVersion.id,
      promptVersion: promptVersion.version,
      input: { subject: emailSubject, body: emailBody, sender_email: senderEmail },
      claim: extractedClaim,
      trainability,
    });

    // ── g) Handle parse failure (technical error, not a classification) ──────
    // parse_failed=true means the model returned unparseable output — this is
    // a provider/schema error, NOT a genuine is_claim=false classification.
    // Set escalado so a human can re-trigger, never no_relevante.
    if (extractedClaim.parse_failed === true) {
      // `escalateCase` es este mismo cuerpo, y está treinta líneas más abajo en
      // este archivo: mismo `escalado`, mismo `updated_at`, mismo payload de
      // auditoría. Estaba escrito dos veces.
      //
      // Una diferencia que vale nombrar: `escalateCase` pasa por
      // `updateCaseStatus`, que atrapa el error de base y lo registra en vez de
      // propagarlo. Es el mismo comportamiento que ya tenía el escalado por
      // error de Gemini, así que esto los unifica.
      await escalateCase(caseId, tenantCtx, userId, "parse_failed", "ai_parse_error");
      console.warn(JSON.stringify({ level: "warn", service: "claimmix", msg: "email_worker.parse_failed_escalated", case_id: caseId }));
      return;
    }

    // ── h) Handle is_claim=false — AC5 ───────────────────────────────────────
    //
    // Except on a case already established as a claim. A photo arrived on a
    // finished-looking crash report, the extractor read that one message and
    // said "not a claim", and the case went to no_relevante — the orchestrator
    // returns early on that, so the person also got silence. Someone sending
    // more evidence must never be able to delete their own claim.
    //
    // The first classification still stands: a case that was never a claim
    // stays not one, and a human can always mark it either way.
    if (extractedClaim.is_claim === false && caseRow.is_claim === true) {
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "claimmix",
          msg: "email_worker.ignored_unclaim",
          case_id: caseId,
        })
      );
    } else if (extractedClaim.is_claim === false) {
      const reason =
        extractedClaim.not_relevant_reason ||
        "El clasificador de IA determinó que este email no es un reclamo de seguro.";

      await enTenant(tenantCtx, (db) =>
        db
        .update(cases)
        .set({
          status: "no_relevante",
          is_claim: false,
          not_relevant_reason: reason.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .where(eq(cases.id, caseId))
      );

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
      try {
        await upsertExtractedFields(caseId, tenantCtx, fieldsToWrite);
      } catch (err) {
        console.error("[email-worker] extracted_fields upsert error:", dbErrCode(err));
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
      try {
        await insertMissingDocsIfAbsent(caseId, tenantCtx, missingFieldKeys);
      } catch (err) {
        console.error("[email-worker] missing_docs upsert error:", dbErrCode(err));
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
      /*
       * El `if` NO es de estilo: sólo pisa si el modelo trajo algo.
       *
       * A esta altura `fields[]` ya tiene lo que salió de la hidratación y del
       * parser de respaldo. Un `""` del modelo —que los manda— borraría un
       * valor que sí encontramos en el texto, y el buscador de clientes se
       * quedaría sin la clave por la que iba a encontrar a la persona.
       *
       * Un `Object.assign` o un spread liso harían eso.
       */
      for (const clave of CLAIM_FIELD_KEYS) {
        const valor = ef[clave];
        if (valor) extractedClaimFields[clave] = valor;
      }
    }
    const customerMatches = await findCustomerMatches(
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
      tenantId,
      policyNumber,
      resolvedCustomerId
    );

    if (!resolvedPolicyId && policyMatches.length > 0) {
      resolvedPolicyId = policyMatches[0]?.policyId;
    }

    // ── k) En qué estado queda el caso tras leer el mensaje ───────────────────
    //
    // La decisión vive en `@/core/case/status-after-extraction`: son cuatro
    // ramas puras que acá adentro no se podían probar sin montar medio worker.
    // Y ojo: para los cuatro canales que este worker atiende, más abajo viene
    // `orchestratePostExtraction`, que vuelve a decidir con más información y
    // muchas veces pisa esto. Es un intermedio, no la última palabra.
    let newStatus: string = estadoTrasExtraer({
      necesitaEspecialista: needsSpecialist,
      camposFaltantes: missingFieldKeys.length,
      camposPorConfirmar: (extractedClaim.fields_pending_confirmation ?? []).length,
    });

    // La guarda de la máquina de estados (LLM08), también pura y también en
    // `@/core/case/status-after-extraction`.
    const currentStatus = caseRow.status as string;

    if (!sePuedeTransicionar(currentStatus, newStatus, isValidTransition)) {
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
    const caseUpdate: Partial<CaseInsert> = {
      is_claim: true,
      severity: finalSeverity,
      requires_specialist: needsSpecialist,
      status: newStatus as CaseInsert["status"],
      updated_at: new Date().toISOString(),
    };
    const confidenceValues = fieldsToWrite.map((field) => field.confidence);
    if (confidenceValues.length > 0) {
      caseUpdate.confidence_min = Math.min(...confidenceValues).toFixed(2);
    } else if (typeof extractedClaim.confidence === "number" && extractedClaim.confidence > 0) {
      caseUpdate.confidence_min = extractedClaim.confidence.toFixed(2);
    }

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
    // Parser fallback fields are persisted for review, but they should not
    // overwrite cases.claim_type when the AI omitted claim_type.
    const rawClaimType = aiClaimType;

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

    // ── Fraud risk assessment ─────────────────────────────────────────────────
    if (extractedClaim.fraud_risk_level && extractedClaim.fraud_risk_level !== "none") {
      (caseUpdate as Record<string, unknown>).fraud_risk_level = extractedClaim.fraud_risk_level;
    }
    if (Array.isArray(extractedClaim.fraud_indicators) && extractedClaim.fraud_indicators.length > 0) {
      (caseUpdate as Record<string, unknown>).fraud_indicators = extractedClaim.fraud_indicators;
    }

    // ── Granular injury severity ──────────────────────────────────────────────
    if (extractedClaim.injury_severity != null) {
      (caseUpdate as Record<string, unknown>).injury_severity = extractedClaim.injury_severity;
    }

    try {
      await enTenant(tenantCtx, (db) =>
        db.update(cases).set(caseUpdate).where(eq(cases.id, caseId))
      );
    } catch (err) {
      console.error("[email-worker] Case update error:", dbErrCode(err));
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
    // Every channel, one decision tree. WhatsApp used to be excluded here and
    // ran its own logic in server/whatsapp/notify.ts, which is how the two
    // drifted: a reported fire got a routine receipt, and a follow-up message
    // got no answer at all. The messenger differs, the reasoning does not.
    if (
      caseRow.channel === "email" ||
      caseRow.channel === "email_sim" ||
      caseRow.channel === "whatsapp" ||
      caseRow.channel === "whatsapp_sim"
    ) {
      await orchestratePostExtraction(
        caseId,
        tenantId,
        {
          extractedClaim,
          senderEmail,
          // Left undefined on purpose: dispatch reads the RFC Message-ID off
          // the inbound claim_messages row itself. This comment used to say
          // the same thing while dispatch did no such lookup, so no reply ever
          // carried In-Reply-To.
          inReplyToMessageId: undefined,
          latestMessageText: latestInboundText,
        },
        customerMatches,
        messengerFor(caseRow.channel)
      );
    }

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

    // GeminiExtractionError = provider/network/quota failure, NOT a genuine
    // is_claim=false classification. Set escalado so it can be re-analyzed once
    // the provider recovers. Do not let the case become no_relevante by accident.
    if (err instanceof GeminiExtractionError) {
      // The error carries the real provider status/code (e.g. 429 /
      // RESOURCE_EXHAUSTED) on its cause — surface it instead of a generic label.
      const cause = (err as GeminiExtractionError).cause as
        | { status?: number; code?: string }
        | undefined;
      const errStatus = typeof cause?.status === "number" ? cause.status : null;
      const errCode = typeof cause?.code === "string" ? cause.code : null;
      try {
        await enTenant(tenantCtx, (db) =>
          db
            .update(cases)
            .set({ status: "escalado", updated_at: new Date().toISOString() })
            .where(eq(cases.id, caseId))
        );

        await writeAuditLog({
          tenant_id: tenantId,
          actor_id: userId,
          event_type: AuditEvent.AI_EXTRACTED,
          target_type: "case",
          target_id: caseId,
          payload: {
            new_status: "escalado",
            reason: "provider_error",
            error_code: errCode ?? "gemini_extraction_failed",
            error_status: errStatus,
            error_name: errName,
          },
        });

        await logAgentRunError({
          tenantId,
          caseId,
          claimMessageId,
          providerMessageId,
          input: { subject: emailSubject, body: emailBody, sender_email: senderEmail },
          errorName: errName,
          errorStatus: errStatus,
          errorCode: errCode,
        });
      } catch {
        // best-effort escalation — don't rethrow
      }
    }

    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "email_worker.unhandled_error",
        case_id: caseId,
        error_name: errName,
        is_provider_error: err instanceof GeminiExtractionError,
      })
    );
    // Do not rethrow — fire-and-forget callers must not crash.
  } finally {
    if (leaseHeld) {
      // A message that landed while we were running was never read: the run
      // that would have read it deferred to us. Run again for it.
      const arrivedWhileBusy = await releaseExtractionLease(caseId, tenantCtx);
      if (arrivedWhileBusy) {
        console.info(
          JSON.stringify({
            level: "info",
            service: "claimmix",
            msg: "email_worker.rerun_for_deferred_message",
            case_id: caseId,
          })
        );
        await redispatchExtraction(caseId, tenantId);
      }
    }
  }
}

// ── Helper: load memory hints ─────────────────────────────────────────────────

function toPromptMemoryHints(
  hints: Awaited<ReturnType<typeof loadClaimMemoryHints>>
): Array<{ field_key: string; value: string; confirmed_at?: string }> {
  const promptHints: Array<{ field_key: string; value: string; confirmed_at?: string }> = [];

  for (const hint of hints) {
    if (!hint.value || typeof hint.value !== "object") continue;
    const values = hint.value as Record<string, unknown>;
    for (const [fieldKey, value] of Object.entries(values)) {
      if (typeof value !== "string" || !value.trim()) continue;
      promptHints.push({
        field_key: fieldKey,
        value,
        confirmed_at: hint.source === "human_confirmation" ? new Date().toISOString() : undefined,
      });
    }
  }

  const seen = new Set<string>();
  return promptHints.filter((hint) => {
    if (seen.has(hint.field_key)) return false;
    seen.add(hint.field_key);
    return true;
  });
}

// ── Helper: load known_claim_patterns ────────────────────────────────────────

async function loadKnownPatterns(tenantCtx: TenantContext): Promise<KnownPattern[]> {
  try {
    const data = await enTenant(tenantCtx, (db) =>
      db
      .select({
        pattern_text: knownClaimPatterns.pattern_text,
        pattern_type: knownClaimPatterns.pattern_type,
        severity_hint: knownClaimPatterns.severity_hint,
        language: knownClaimPatterns.language,
      })
      .from(knownClaimPatterns)
      // Sin el `or(isNull(...), eq(...))` que había acá: la política de la
      // tabla (migración 0019) ya deja ver lo propio Y lo global. Escribirlo
      // otra vez no agregaría nada y haría pensar que sin eso las reglas
      // globales se perderían — que es justo lo que 0019 vino a evitar.
      .where(eq(knownClaimPatterns.enabled, true))
      .limit(200)
    );

    return data.map((row) => ({
      pattern_text: row.pattern_text ?? "",
      pattern_type: row.pattern_type ?? "keyword",
      severity_hint: row.severity_hint ?? "medium",
      language: row.language ?? "es-AR",
    }));
  } catch (err) {
    console.error("[email-worker] known_claim_patterns load error:", dbErrCode(err));
    return [];
  }
}

// ── Helpers (shared with legacy worker) ───────────────────────────────────────

/** Extract a loggable error code from a thrown DB error (PII-safe). */
function dbErrCode(err: unknown): string {
  return (
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.name : "UnknownError")
  );
}

/**
 * Upsert extracted_fields rows on the (case_id, field_key) unique constraint
 * (uq_extracted_field in 0001_init.sql). Throws on DB error — callers wrap.
 */
async function upsertExtractedFields(
  caseId: string,
  tenantCtx: TenantContext,
  fields: Array<{ field_key: string; field_value: string; confidence: number }>
): Promise<void> {
  // El tenant_id sigue yendo en los valores: ahí no es un filtro, es el dueño
  // de la fila. Y ahora la base comprueba que coincida con el contexto —
  // escribir en la cuenta de otro pasó de ser posible a ser rechazado.
  const fieldInserts = fields.map((f) => ({
    case_id: caseId,
    tenant_id: tenantCtx.tenantId,
    field_key: f.field_key,
    field_value: f.field_value,
    confidence: f.confidence.toFixed(2),
  }));

  await enTenant(tenantCtx, (db) =>
    db
    .insert(extractedFields)
    .values(fieldInserts)
    .onConflictDoUpdate({
      target: [extractedFields.case_id, extractedFields.field_key],
      set: {
        field_value: sql`excluded.field_value`,
        // Never become less sure about an answer that has not changed.
        //
        // The whole conversation is re-extracted on every reply, so a field is
        // re-scored on rounds that told us nothing new about it. "¿Hubo
        // heridos?" was read at 0.95 from the first message and re-read at
        // 0.80 two replies later — under the confirmation threshold — so the
        // agent asked the claimant to confirm something it had already
        // understood and never doubted. Rereading the same sentence is not
        // evidence against it.
        //
        // A value that DID change keeps the new confidence: that is real news,
        // and the conflict branch has the stored value to show alongside.
        confidence: sql`case
          when ${extractedFields.field_value} is not distinct from excluded.field_value
            then greatest(${extractedFields.confidence}, excluded.confidence)
          else excluded.confidence
        end`,
      },
    })
  );
}

/**
 * Insert missing_docs rows that don't exist yet for this case.
 *
 * NOTE: missing_docs has no unique constraint on (case_id, doc_key) in the
 * Neon schema, so the old `upsert(..., { onConflict: "case_id,doc_key" })` is
 * emulated as insert-if-absent (existing rows — including satisfied ones —
 * are left untouched). Throws on DB error — callers wrap.
 */
async function insertMissingDocsIfAbsent(
  caseId: string,
  tenantCtx: TenantContext,
  docKeys: string[]
): Promise<void> {
  const existing = await enTenant(tenantCtx, (db) =>
    db
      .select({ doc_key: missingDocs.doc_key })
      .from(missingDocs)
      .where(eq(missingDocs.case_id, caseId))
  );

  const existingKeys = new Set(existing.map((row) => row.doc_key));
  const newKeys = docKeys.filter((docKey) => !existingKeys.has(docKey));
  if (newKeys.length === 0) return;

  await enTenant(tenantCtx, (db) =>
    db.insert(missingDocs).values(
      newKeys.map((docKey) => ({
        case_id: caseId,
        tenant_id: tenantCtx.tenantId,
        doc_key: docKey,
        requested_at: null,
        satisfied_at: null,
      }))
    )
  );
}

async function updateCaseStatus(
  caseId: string,
  tenantCtx: TenantContext,
  newStatus: "listo" | "esperando" | "escalado",
  confidenceMin: number | null
): Promise<void> {
  const updatePayload: Partial<CaseInsert> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
  if (confidenceMin !== null) {
    updatePayload.confidence_min = confidenceMin.toFixed(2);
  }

  try {
    await enTenant(tenantCtx, (db) =>
      db.update(cases).set(updatePayload).where(eq(cases.id, caseId))
    );
  } catch (err) {
    console.error("[worker] Failed to update case status:", dbErrCode(err), "case:", caseId);
  }
}

async function escalateCase(
  caseId: string,
  tenantCtx: TenantContext,
  userId: string | null,
  auditReason: string,
  errorCode: string
): Promise<void> {
  await updateCaseStatus(caseId, tenantCtx, "escalado", null);
  await writeAuditLog({
    tenant_id: tenantCtx.tenantId,
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

// ── Conversation assembly ─────────────────────────────────────────────────────

interface LoadedConversation {
  body: string;
  subject: string;
  senderEmail: string;
  latestText: string;
  claimMessageId: string | null;
  providerMessageId: string | null;
}

/**
 * Every inbound message on the case, oldest first, as one document.
 *
 * Returns null when the case has no claim_messages at all — the simulate flow
 * writes only raw_messages, and that path still works the way it did.
 */
export async function loadInboundConversation(
  caseId: string,
  tenantCtx: TenantContext
): Promise<LoadedConversation | null> {
  const inbound = await enTenant(tenantCtx, (db) =>
    db
    .select({
      id: claimMessages.id,
      provider_message_id: claimMessages.provider_message_id,
      body_text: claimMessages.body_text,
      subject: claimMessages.subject,
      from_addr: claimMessages.from_addr,
      received_at: claimMessages.received_at,
    })
    .from(claimMessages)
    .where(
      and(
        eq(claimMessages.case_id, caseId),
        eq(claimMessages.direction, "inbound")
      )
    )
    .orderBy(asc(claimMessages.received_at))
  );

  // Defensive: anything other than a row list means we cannot read the
  // conversation, and the raw-message path is the honest fallback.
  if (!Array.isArray(inbound)) return null;

  const latest = inbound[inbound.length - 1];
  if (!latest) return null;

  return {
    body: buildConversationBody(inbound),
    // Subject and identity come from the newest message: it is the one being
    // replied to, and its subject is what the claimant last saw.
    subject: latest.subject ?? "",
    senderEmail: latest.from_addr ?? "",
    latestText: stripQuotedReply(latest.body_text ?? ""),
    claimMessageId: latest.id ?? null,
    providerMessageId: latest.provider_message_id ?? null,
  };
}

// ── Lo que se mudó al núcleo ────────────────────────────────────────────────
//
// `stripQuotedReply` y `buildConversationBody` viven ahora en
// `src/core/email/conversation.ts`: son texto entrando y texto saliendo, sin
// base de datos ni reloj de por medio, y ahí se pueden probar sin montar nada.
// Se re-exportan desde acá porque es de donde las importa todo el mundo.
export { stripQuotedReply, buildConversationBody };
