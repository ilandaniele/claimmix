/**
 * training_examples — human-approved examples the agent may learn from.
 *
 * Learning strategy (three layers, in order of immediacy):
 *   1. Immediate: approved examples are retrieved as few-shot context for
 *      future extractions of the same tenant (loadApprovedExamples).
 *   2. Prompt learning: agent_prompt_rules (see prompt-rules.ts).
 *   3. Optional training package: Gemini context packs by default, with OpenAI
 *      fine-tuning still available only when explicitly selected.
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
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { countRows, firstRow } from "@/lib/db/helpers";
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
  tenantId: string,
  claimType?: string | null
): Promise<ApprovedExample[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const t = tables.trainingExamples;
    const collected: Array<{
      id: string;
      input_payload: { subject?: string; body?: string };
      expected_output: Record<string, unknown>;
    }> = [];

    if (claimType) {
      const data = (await enTenant(tenantCtx, (db) =>
        db
          .select({
            id: t.id,
            input_payload: t.input_payload,
            expected_output: t.expected_output,
          })
          .from(t)
          .where(
            and(
              eq(t.status, "approved"),
              eq(t.claim_type, claimType)
            )
          )
          .orderBy(desc(t.approved_at))
          .limit(MAX_EXAMPLES)) as typeof collected
      );
      collected.push(...data);
    }

    if (collected.length < MAX_EXAMPLES) {
      const data = (await enTenant(tenantCtx, (db) =>
        db
          .select({
            id: t.id,
            input_payload: t.input_payload,
            expected_output: t.expected_output,
          })
          .from(t)
          .where(eq(t.status, "approved"))
          .orderBy(desc(t.approved_at))
          .limit(MAX_EXAMPLES * 2)) as typeof collected
      );
      for (const row of data) {
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
 * - Does not queue fine-tuning; the example is available to prompts immediately.
 */
export async function approveTrainingExample(
  params: ApproveTrainingExampleParams
): Promise<ApproveResult> {
  const { tenantId, agentRunId, approvedBy } = params;
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId };

  // ── 1. Load the agent run ───────────────────────────────────────────────────
  let run: {
    id: string;
    case_id: string | null;
    claim_message_id: string | null;
    input_payload: unknown;
    output_payload: unknown;
    blocking_reasons: unknown;
  } | null;
  try {
    const t = tables.agentRuns;
    run = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({
            id: t.id,
            case_id: t.case_id,
            claim_message_id: t.claim_message_id,
            input_payload: t.input_payload,
            output_payload: t.output_payload,
            blocking_reasons: t.blocking_reasons,
          })
          .from(t)
          .where(eq(t.id, agentRunId))
          .limit(1)
      )
    );
  } catch {
    run = null;
  }

  if (!run) {
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
    // Se captura antes de las consultas a propósito.
    //
    // El `if` de arriba angosta `run.case_id` a string, pero ese angostamiento
    // se pierde dentro de la función flecha que recibe la capa de datos: el
    // compilador no puede probar que la propiedad no cambió en el medio. Con
    // el filtro escrito a mano esto no pasaba porque la expresión estaba en la
    // consulta, no en un callback.
    const caseId = run.case_id;
    try {
      const ef = tables.extractedFields;
      const c = tables.cases;
      const [fields, caseRows] = await Promise.all([
        enTenant(tenantCtx, (db) =>
          db
            .select({
              field_key: ef.field_key,
              field_value: ef.field_value,
              confidence: ef.confidence,
            })
            .from(ef)
            .where(eq(ef.case_id, caseId))
        ),
        enTenant(tenantCtx, (db) =>
          db
            .select({ claim_type: c.claim_type })
            .from(c)
            .where(eq(c.id, caseId))
            .limit(1)
        ),
      ]);
      // numeric → string under Drizzle; convert to keep the stored JSON shape.
      confirmedFields = fields.map((f) => ({
        field_key: f.field_key,
        field_value: f.field_value,
        confidence: Number(f.confidence),
      }));
      claimType = firstRow(caseRows)?.claim_type ?? null;
    } catch {
      confirmedFields = [];
      claimType = null;
    }
  }

  const expectedOutput = {
    agent_output: run.output_payload ?? {},
    confirmed_fields: confirmedFields,
  };

  // ── 4. Insert (unique indexes enforce dedupe) ───────────────────────────────
  const nowIso = new Date().toISOString();
  let exampleId: string;
  try {
    const inserted = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .insert(tables.trainingExamples)
          .values({
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
          .returning({ id: tables.trainingExamples.id })
      )
    );

    if (!inserted) {
      console.error("[training-examples] insert error:", "no_data"); // crew-debug-ok
      return { ok: false, reason: "insert_failed" };
    }

    exampleId = inserted.id;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "23505") {
      return { ok: false, reason: "duplicate" };
    }
    console.error("[training-examples] insert error:", code ?? "no_data"); // crew-debug-ok
    return { ok: false, reason: "insert_failed" };
  }

  // ── 5. Audit event (claim_events equivalent in this codebase: audit_log) ───
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: approvedBy,
    event_type: AuditEvent.TRAINING_EXAMPLE_APPROVED,
    target_type: "case",
    target_id: run.case_id,
    payload: { agent_run_id: agentRunId, training_example_id: exampleId },
  });

  // Fine-tuning is optional/manual; approved examples are prompt context now.
  const queuedFineTuneJobId = null;

  return { ok: true, exampleId, queuedFineTuneJobId };
}

// ── Batched fine-tuning queue ─────────────────────────────────────────────────

/** Minimum approved examples before a training package is drafted. */
function getFineTuneMinExamples(): number {
  const raw = Number(process.env.FINETUNE_MIN_EXAMPLES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
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
  tenantId: string,
  createdBy: string | null
): Promise<string | null> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const te = tables.trainingExamples;
    const approvedCount = await countRows(
      te,
      and(eq(te.tenant_id, tenantId), eq(te.status, "approved"))
    );

    const threshold = getFineTuneMinExamples();
    if (approvedCount < threshold) return null;

    const mtj = tables.modelTrainingJobs;
    const openJobs = await enTenant(tenantCtx, (db) =>
      db
        .select({ id: mtj.id })
        .from(mtj)
        .where(
          and( inArray(mtj.status, OPEN_JOB_STATUSES))
        )
        .limit(1)
    );

    if (openJobs.length > 0) return null;

    const job = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .insert(mtj)
          .values({
            tenant_id: tenantId,
            status: "draft",
            provider: "gemini",
            base_model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
            training_example_count: approvedCount,
            created_by: createdBy,
          })
          .returning({ id: mtj.id })
      )
    );

    if (!job) return null;

    const jobId = job.id;

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: createdBy,
      event_type: AuditEvent.FINETUNE_JOB_QUEUED,
      target_type: "model_training_job",
      target_id: jobId,
      payload: {
        job_id: jobId,
        provider: "gemini",
        training_example_count: approvedCount,
      },
    });

    return jobId;
  } catch {
    return null;
  }
}
