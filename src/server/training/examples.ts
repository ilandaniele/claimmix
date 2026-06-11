/**
 * training_examples — human-approved examples the agent may learn from.
 *
 * Learning strategy (three layers, in order of immediacy):
 *   1. Immediate: approved examples are retrieved as few-shot context for
 *      future extractions of the same tenant (loadApprovedExamples).
 *   2. Prompt learning: agent_prompt_rules (see prompt-rules.ts).
 *   3. Optional fine-tuning: BATCH ONLY — when enough approved examples exist
 *      a model_training_jobs row is created in 'draft'. Nothing trains or
 *      deploys automatically; evals + manual approval gate deployment.
 *
 * Security invariants:
 *   - Examples are created ONLY by approveTrainingExample(), which is called
 *     ONLY from the human-confirmation endpoint (admin/specialist role).
 *   - Runs flagged invalid_json or prompt_injection_suspected can NEVER be
 *     approved, even by an admin (UNSAFE_BLOCKING_REASONS).
 *   - Duplicates are impossible: unique index per (tenant, agent_run) and
 *     per (tenant, claim_message).
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { UNSAFE_BLOCKING_REASONS } from "./trainability";

// ── Few-shot retrieval (immediate learning layer) ─────────────────────────────

export interface ApprovedExample {
  /** Truncated input the agent saw. */
  input: { subject: string; body: string };
  /** The human-validated expected output (confirmed field values). */
  expectedOutput: Record<string, unknown>;
}

/** Few-shot examples injected per run. */
const MAX_EXAMPLES = 3;

/** Body excerpt size per example — keeps prompt growth bounded. */
const EXAMPLE_BODY_CHARS = 1_200;

/**
 * Retrieve approved training examples for few-shot injection.
 *
 * Similarity heuristic (no vector store in MVP): prefer examples with the
 * same claim_type as the current case, newest first, then fill the remaining
 * slots with the newest approved examples of any type. Tenant-scoped.
 */
export async function loadApprovedExamples(
  supabase: SupabaseClient,
  tenantId: string,
  claimType?: string | null
): Promise<ApprovedExample[]> {
  try {
    const collected: Array<{
      id: string;
      input_payload: { subject?: string; body?: string };
      expected_output: Record<string, unknown>;
    }> = [];

    if (claimType) {
      const { data } = await (supabase as any)
        .from("training_examples")
        .select("id,input_payload,expected_output")
        .eq("tenant_id", tenantId)
        .eq("status", "approved")
        .eq("claim_type", claimType)
        .order("approved_at", { ascending: false })
        .limit(MAX_EXAMPLES);
      if (data) collected.push(...data);
    }

    if (collected.length < MAX_EXAMPLES) {
      const { data } = await (supabase as any)
        .from("training_examples")
        .select("id,input_payload,expected_output")
        .eq("tenant_id", tenantId)
        .eq("status", "approved")
        .order("approved_at", { ascending: false })
        .limit(MAX_EXAMPLES * 2);
      for (const row of data ?? []) {
        if (collected.length >= MAX_EXAMPLES) break;
        if (!collected.some((c) => c.id === row.id)) collected.push(row);
      }
    }

    return collected.slice(0, MAX_EXAMPLES).map((row) => ({
      input: {
        subject: (row.input_payload?.subject ?? "").slice(0, 300),
        body: (row.input_payload?.body ?? "").slice(0, EXAMPLE_BODY_CHARS),
      },
      expectedOutput: row.expected_output ?? {},
    }));
  } catch {
    return [];
  }
}

/**
 * Format approved examples for prompt injection inside <approved_examples>.
 * Returns "" when there are none.
 */
export function formatApprovedExamples(examples: ApprovedExample[]): string {
  if (examples.length === 0) return "";
  return examples
    .map(
      (example, i) =>
        `EXAMPLE ${i + 1} (human-approved):\nINPUT subject: ${example.input.subject}\nINPUT body (excerpt): ${example.input.body}\nEXPECTED OUTPUT: ${JSON.stringify(example.expectedOutput)}`
    )
    .join("\n\n");
}

// ── Human approval (the ONLY way an example is created) ───────────────────────

export type ApproveResult =
  | { ok: true; exampleId: string; queuedFineTuneJobId: string | null }
  | {
      ok: false;
      reason: "run_not_found" | "duplicate" | "unsafe_run" | "insert_failed";
    };

export interface ApproveTrainingExampleParams {
  tenantId: string;
  agentRunId: string;
  approvedBy: string;
}

/**
 * Approve an agent run as a safe training example.
 *
 * - Loads the run (tenant-scoped) and refuses unsafe runs (invalid JSON or
 *   suspected prompt injection) — these cannot be overridden by a human.
 * - expected_output = the extractor output PLUS the analyst-confirmed field
 *   values current at approval time (extracted_fields reflects corrections).
 * - Dedupe via unique indexes; 23505 → "duplicate".
 * - Writes a TRAINING_EXAMPLE_APPROVED audit event.
 * - May queue a draft fine-tuning job (batch threshold) — never trains.
 */
export async function approveTrainingExample(
  supabase: SupabaseClient,
  params: ApproveTrainingExampleParams
): Promise<ApproveResult> {
  const { tenantId, agentRunId, approvedBy } = params;

  // ── 1. Load the agent run ───────────────────────────────────────────────────
  const { data: run, error: runError } = await (supabase as any)
    .from("agent_runs")
    .select(
      "id,case_id,claim_message_id,input_payload,output_payload,blocking_reasons"
    )
    .eq("id", agentRunId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (runError || !run) {
    return { ok: false, reason: "run_not_found" };
  }

  // ── 2. Safety gate — not human-overridable ──────────────────────────────────
  const blocking: string[] = Array.isArray(run.blocking_reasons)
    ? run.blocking_reasons
    : [];
  if (blocking.some((reason) => UNSAFE_BLOCKING_REASONS.has(reason))) {
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: approvedBy,
      event_type: AuditEvent.TRAINING_EXAMPLE_REJECTED,
      target_type: "case",
      target_id: run.case_id,
      payload: { agent_run_id: agentRunId, reason: "unsafe_run" },
    });
    return { ok: false, reason: "unsafe_run" };
  }

  // ── 3. Build expected_output: extractor output + confirmed field values ────
  // extracted_fields reflects analyst corrections (confirm-field flow), so the
  // approved example teaches the CORRECTED values, not raw model output.
  let confirmedFields: Array<{ field_key: string; field_value: string; confidence: number }> = [];
  let claimType: string | null = null;

  if (run.case_id) {
    const [{ data: fields }, { data: caseRow }] = await Promise.all([
      (supabase as any)
        .from("extracted_fields")
        .select("field_key,field_value,confidence")
        .eq("case_id", run.case_id),
      (supabase as any)
        .from("cases")
        .select("claim_type")
        .eq("id", run.case_id)
        .maybeSingle(),
    ]);
    confirmedFields = fields ?? [];
    claimType = caseRow?.claim_type ?? null;
  }

  const expectedOutput = {
    agent_output: run.output_payload ?? {},
    confirmed_fields: confirmedFields,
  };

  // ── 4. Insert (unique indexes enforce dedupe) ───────────────────────────────
  const nowIso = new Date().toISOString();
  const { data: inserted, error: insertError } = await (supabase as any)
    .from("training_examples")
    .insert({
      tenant_id: tenantId,
      agent_run_id: agentRunId,
      case_id: run.case_id,
      claim_message_id: run.claim_message_id,
      claim_type: claimType,
      input_payload: run.input_payload ?? {},
      expected_output: expectedOutput,
      status: "approved",
      approved_by: approvedBy,
      approved_at: nowIso,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    if (insertError?.code === "23505") {
      return { ok: false, reason: "duplicate" };
    }
    console.error("[training-examples] insert error:", insertError?.code ?? "no_data"); // crew-debug-ok
    return { ok: false, reason: "insert_failed" };
  }

  const exampleId = (inserted as { id: string }).id;

  // ── 5. Audit event (claim_events equivalent in this codebase: audit_log) ───
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: approvedBy,
    event_type: AuditEvent.TRAINING_EXAMPLE_APPROVED,
    target_type: "case",
    target_id: run.case_id,
    payload: { agent_run_id: agentRunId, training_example_id: exampleId },
  });

  // ── 6. Batch fine-tuning queue (draft only — see module header) ────────────
  const queuedFineTuneJobId = await maybeQueueFineTuneJob(
    supabase,
    tenantId,
    approvedBy
  );

  return { ok: true, exampleId, queuedFineTuneJobId };
}

// ── Batched fine-tuning queue ─────────────────────────────────────────────────

/** Minimum approved examples before a fine-tune job is even drafted. */
function getFineTuneMinExamples(): number {
  const raw = Number(process.env.FINETUNE_MIN_EXAMPLES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
}

/** Job states that count as "already in flight" — prevents duplicate drafts. */
const OPEN_JOB_STATUSES = ["draft", "queued", "running", "eval_pending"];

/**
 * Create a DRAFT model_training_jobs row when the approved-example count
 * reaches the batch threshold and no job is already open. Returns the new
 * job id, or null when below threshold / job already open / on error.
 *
 * Deliberately does NOT call any fine-tuning API: too much noisy/duplicated
 * training data makes the agent worse, so jobs require human curation,
 * evals, and explicit approval before anything is trained or deployed.
 */
export async function maybeQueueFineTuneJob(
  supabase: SupabaseClient,
  tenantId: string,
  createdBy: string | null
): Promise<string | null> {
  try {
    const { count, error: countError } = await (supabase as any)
      .from("training_examples")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "approved");

    if (countError) return null;

    const approvedCount = count ?? 0;
    const threshold = getFineTuneMinExamples();
    if (approvedCount < threshold) return null;

    const { data: openJobs, error: openError } = await (supabase as any)
      .from("model_training_jobs")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("status", OPEN_JOB_STATUSES)
      .limit(1);

    if (openError || (openJobs && openJobs.length > 0)) return null;

    const { data: job, error: jobError } = await (supabase as any)
      .from("model_training_jobs")
      .insert({
        tenant_id: tenantId,
        status: "draft",
        provider: "openai",
        base_model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        training_example_count: approvedCount,
        created_by: createdBy,
      })
      .select("id")
      .single();

    if (jobError || !job) return null;

    const jobId = (job as { id: string }).id;

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: createdBy,
      event_type: AuditEvent.FINETUNE_JOB_QUEUED,
      target_type: "model_training_job",
      target_id: jobId,
      payload: { job_id: jobId, training_example_count: approvedCount },
    });

    return jobId;
  } catch {
    return null;
  }
}
