/**
 * Batched model-training lifecycle for the claim agent.
 *
 * OpenAI jobs can be uploaded to the provider. Gemini Developer API does not
 * currently expose public fine-tuning, so Gemini jobs are context packs: JSONL
 * plus metadata assembled from approved examples for backup, evaluation, and
 * prompt-memory portability. No Gemini context-pack action calls OpenAI.
 */

import "server-only";
import { createHash } from "crypto";
import OpenAI, { toFile } from "openai";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import {
  getDefaultGeminiModel,
  getDefaultOpenAIModel,
  getTenantAiProvider,
  getTenantGeminiModel,
  getTenantOpenAIModel,
  setTenantModelDefaults,
  type AiProvider,
} from "@/server/ai/provider";

const OPEN_JOB_STATUSES = ["draft", "queued", "running", "eval_pending", "approved"];

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey });
}

function mapOpenAIStatus(status: string): string {
  if (status === "validating_files" || status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "succeeded") return "eval_pending";
  if (status === "failed" || status === "cancelled") return "failed";
  return "queued";
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildExpectedOutput(expectedOutput: Record<string, unknown>): Record<string, unknown> {
  const agentOutput =
    expectedOutput.agent_output && typeof expectedOutput.agent_output === "object"
      ? { ...(expectedOutput.agent_output as Record<string, unknown>) }
      : { ...expectedOutput };
  const confirmed = Array.isArray(expectedOutput.confirmed_fields)
    ? expectedOutput.confirmed_fields
    : [];
  if (confirmed.length > 0) {
    agentOutput.fields = confirmed;
  }
  return agentOutput;
}

function toJsonlLine(example: {
  input_payload: Record<string, unknown>;
  expected_output: Record<string, unknown>;
}): string {
  const subject = typeof example.input_payload.subject === "string" ? example.input_payload.subject : "";
  const body = typeof example.input_payload.body === "string" ? example.input_payload.body : "";
  return JSON.stringify({
    messages: [
      {
        role: "system",
        content:
          "You are the ClaimMix claim intake agent. Return only valid JSON matching the production extraction schema.",
      },
      {
        role: "user",
        content: `Subject: ${subject}\n\nBody:\n${body}`,
      },
      {
        role: "assistant",
        content: JSON.stringify(buildExpectedOutput(example.expected_output)),
      },
    ],
  });
}

async function approvedExamplesForTenant(tenantId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const t = tables.trainingExamples;
  const rows = await enTenant(tenantCtx, (db) =>
    db
      .select({
        id: t.id,
        input_payload: t.input_payload,
        expected_output: t.expected_output,
        created_at: t.created_at,
      })
      .from(t)
      .where(eq(t.status, "approved"))
      .orderBy(desc(t.created_at))
      .limit(500)
  );

  const seen = new Set<string>();
  return rows
    .map((row) => ({
      ...row,
      input_payload: (row.input_payload ?? {}) as Record<string, unknown>,
      expected_output: (row.expected_output ?? {}) as Record<string, unknown>,
    }))
    .filter((row) => {
      const hash = stableHash([row.input_payload, row.expected_output]);
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    });
}

function geminiContextEvalResult(input: {
  trainingCount: number;
  validationCount: number;
  model: string;
}) {
  return {
    mode: "gemini_context_pack",
    provider: "gemini",
    model: input.model,
    external_fine_tuning_supported: false,
    used_by_agent_as: "few_shot_context",
    training_count: input.trainingCount,
    validation_count: input.validationCount,
    notes:
      "Gemini API/AI Studio fine-tuning is not called. Approved examples remain active as agent memory/context.",
  };
}

async function createOrRefreshGeminiContextJob(
  tenantId: string,
  userId: string,
  existingJobId?: string
) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const jsonl = await buildFineTuneJsonl(tenantId);
  if (jsonl.trainingCount < 1) throw new Error("NO_APPROVED_EXAMPLES");

  const t = tables.modelTrainingJobs;
  const model = (await getTenantGeminiModel(tenantId)) || getDefaultGeminiModel();
  const now = new Date().toISOString();

  let targetId = existingJobId;
  if (!targetId) {
    const existing = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: t.id })
          .from(t)
          .where(and( eq(t.provider, "gemini"), inArray(t.status, OPEN_JOB_STATUSES)))
          .limit(1)
      )
    );
    targetId = existing?.id;
  }

  const values = {
    status: "approved",
    provider: "gemini",
    base_model: model,
    fine_tuned_model_id: null,
    openai_fine_tuning_job_id: null,
    training_file_id: "gemini-context-jsonl",
    validation_file_id: jsonl.validationJsonl ? "gemini-context-validation-jsonl" : null,
    result_files: [],
    error_message: null,
    training_jsonl: jsonl.trainingJsonl,
    validation_jsonl: jsonl.validationJsonl || null,
    training_example_count: jsonl.trainingCount + jsonl.validationCount,
    eval_result: geminiContextEvalResult({
      trainingCount: jsonl.trainingCount,
      validationCount: jsonl.validationCount,
      model,
    }),
    started_at: now,
    completed_at: now,
  };

  const job = targetId
    ? firstRow(
        await enTenant(tenantCtx, (db) =>
          db
            .update(t)
            .set(values)
            .where(and(eq(t.id, targetId), eq(t.provider, "gemini")))
            .returning({ id: t.id })
        )
      )
    : firstRow(
        await db
          .insert(t)
          .values({
            tenant_id: tenantId,
            created_by: userId,
            ...values,
          })
          .returning({ id: t.id })
      );

  if (!job) throw new Error("INSERT_FAILED");

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.FINETUNE_JOB_QUEUED,
    target_type: "model_training_job",
    target_id: job.id,
    payload: {
      job_id: job.id,
      provider: "gemini",
      mode: "context_pack",
      training_example_count: jsonl.trainingCount + jsonl.validationCount,
    },
  });

  return job;
}

export async function listFineTuneJobs(tenantId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const t = tables.modelTrainingJobs;
  return enTenant(tenantCtx, (db) =>
    db
      .select({
        id: t.id,
        status: t.status,
        provider: t.provider,
        base_model: t.base_model,
        fine_tuned_model_id: t.fine_tuned_model_id,
        openai_fine_tuning_job_id: t.openai_fine_tuning_job_id,
        training_file_id: t.training_file_id,
        validation_file_id: t.validation_file_id,
        result_files: t.result_files,
        error_message: t.error_message,
        training_example_count: t.training_example_count,
        eval_result: t.eval_result,
        created_at: t.created_at,
        started_at: t.started_at,
        completed_at: t.completed_at,
        activated_at: t.activated_at,
      })
      .from(t)
      .orderBy(desc(t.created_at))
      .limit(50)
  );
}

export async function createDraftFineTuneJob(
  tenantId: string,
  userId: string,
  provider?: AiProvider
) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const examples = await approvedExamplesForTenant(tenantId);
  if (examples.length < 1) throw new Error("NO_APPROVED_EXAMPLES");

  const selectedProvider = provider ?? (await getTenantAiProvider(tenantId));
  if (selectedProvider === "gemini") {
    return createOrRefreshGeminiContextJob(tenantId, userId);
  }

  const t = tables.modelTrainingJobs;
  const open = await enTenant(tenantCtx, (db) =>
    db
      .select({ id: t.id })
      .from(t)
      .where(and( eq(t.provider, "openai"), inArray(t.status, OPEN_JOB_STATUSES)))
      .limit(1)
  );
  if (open.length > 0) return open[0];

  const baseModel = await getTenantOpenAIModel(tenantId);
  const job = firstRow(
    await db
      .insert(t)
      .values({
        tenant_id: tenantId,
        status: "draft",
        provider: "openai",
        base_model: baseModel || getDefaultOpenAIModel(),
        training_example_count: examples.length,
        created_by: userId,
      })
      .returning({ id: t.id })
  );
  if (!job) throw new Error("INSERT_FAILED");

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.FINETUNE_JOB_QUEUED,
    target_type: "model_training_job",
    target_id: job.id,
    payload: { job_id: job.id, provider: "openai", training_example_count: examples.length },
  });
  return job;
}

export async function buildFineTuneJsonl(tenantId: string) {
  const examples = await approvedExamplesForTenant(tenantId);
  const lines = examples.map(toJsonlLine);
  const validationCount = lines.length >= 10 ? Math.max(1, Math.floor(lines.length * 0.2)) : 0;
  const validation = validationCount > 0 ? lines.slice(0, validationCount) : [];
  const training = validationCount > 0 ? lines.slice(validationCount) : lines;
  return {
    trainingJsonl: training.join("\n") + "\n",
    validationJsonl: validation.length > 0 ? validation.join("\n") + "\n" : "",
    trainingCount: training.length,
    validationCount: validation.length,
  };
}

export async function startFineTuneJob(tenantId: string, userId: string, jobId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const t = tables.modelTrainingJobs;
  const job = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({ id: t.id, status: t.status, provider: t.provider, base_model: t.base_model })
        .from(t)
        .where(eq(t.id, jobId))
        .limit(1)
    )
  );
  if (!job) throw new Error("NOT_FOUND");
  if (job.provider === "gemini") {
    return createOrRefreshGeminiContextJob(tenantId, userId, jobId);
  }
  if (!["draft", "failed"].includes(job.status)) throw new Error("JOB_NOT_STARTABLE");

  const jsonl = await buildFineTuneJsonl(tenantId);
  if (jsonl.trainingCount < 1) throw new Error("NO_APPROVED_EXAMPLES");

  const client = getClient();
  const trainingFile = await client.files.create({
    file: await toFile(Buffer.from(jsonl.trainingJsonl), `claimmix-${jobId}-train.jsonl`),
    purpose: "fine-tune",
  });
  const validationFile = jsonl.validationJsonl
    ? await client.files.create({
        file: await toFile(Buffer.from(jsonl.validationJsonl), `claimmix-${jobId}-validation.jsonl`),
        purpose: "fine-tune",
      })
    : null;

  const openaiJob = await client.fineTuning.jobs.create({
    model: job.base_model || getDefaultOpenAIModel(),
    training_file: trainingFile.id,
    ...(validationFile ? { validation_file: validationFile.id } : {}),
    suffix: `claimmix-${tenantId.slice(0, 8)}`,
  });

  const updated = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .update(t)
        .set({
          status: mapOpenAIStatus(openaiJob.status),
          openai_fine_tuning_job_id: openaiJob.id,
          training_file_id: trainingFile.id,
          validation_file_id: validationFile?.id ?? null,
          training_jsonl: jsonl.trainingJsonl,
          validation_jsonl: jsonl.validationJsonl || null,
          training_example_count: jsonl.trainingCount + jsonl.validationCount,
          eval_result: { openai_status: openaiJob.status, validation_count: jsonl.validationCount },
          error_message: null,
          started_at: new Date().toISOString(),
        })
        .where(eq(t.id, jobId))
        .returning({ id: t.id })
    )
  );

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.FINETUNE_JOB_STARTED,
    target_type: "model_training_job",
    target_id: jobId,
    payload: { job_id: jobId, openai_job_id: openaiJob.id },
  });

  return updated;
}

export async function syncFineTuneJob(tenantId: string, userId: string, jobId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const t = tables.modelTrainingJobs;
  const job = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: t.id,
          provider: t.provider,
          openai_fine_tuning_job_id: t.openai_fine_tuning_job_id,
        })
        .from(t)
        .where(eq(t.id, jobId))
        .limit(1)
    )
  );
  if (!job) throw new Error("NOT_FOUND");
  if (job.provider === "gemini") {
    return createOrRefreshGeminiContextJob(tenantId, userId, jobId);
  }
  if (!job.openai_fine_tuning_job_id) throw new Error("NOT_FOUND");

  const openaiJob = await getClient().fineTuning.jobs.retrieve(job.openai_fine_tuning_job_id);
  const status = mapOpenAIStatus(openaiJob.status);
  const completed = status === "eval_pending" || status === "failed";
  const updated = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .update(t)
        .set({
          status,
          fine_tuned_model_id: openaiJob.fine_tuned_model,
          result_files: openaiJob.result_files ?? [],
          training_file_id: openaiJob.training_file,
          validation_file_id: openaiJob.validation_file,
          error_message: openaiJob.error?.message ?? null,
          eval_result: {
            openai_status: openaiJob.status,
            trained_tokens: openaiJob.trained_tokens,
            error: openaiJob.error,
          },
          completed_at: completed ? new Date().toISOString() : null,
        })
        .where(eq(t.id, jobId))
        .returning({ id: t.id, status: t.status, fine_tuned_model_id: t.fine_tuned_model_id })
    )
  );

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.FINETUNE_JOB_SYNCED,
    target_type: "model_training_job",
    target_id: jobId,
    payload: { job_id: jobId, status },
  });

  return updated;
}

export async function approveFineTuneJob(tenantId: string, userId: string, jobId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const t = tables.modelTrainingJobs;
  const job = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: t.id,
          status: t.status,
          provider: t.provider,
          fine_tuned_model_id: t.fine_tuned_model_id,
          eval_result: t.eval_result,
        })
        .from(t)
        .where(eq(t.id, jobId))
        .limit(1)
    )
  );
  if (!job) throw new Error("NOT_FOUND");
  if (job.provider === "gemini") {
    const updated = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .update(t)
          .set({ status: "approved", completed_at: new Date().toISOString() })
          .where(and(eq(t.id, jobId), eq(t.provider, "gemini")))
          .returning({ id: t.id, status: t.status, fine_tuned_model_id: t.fine_tuned_model_id })
      )
    );
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userId,
      event_type: AuditEvent.FINETUNE_JOB_APPROVED,
      target_type: "model_training_job",
      target_id: jobId,
      payload: { job_id: jobId, provider: "gemini", mode: "context_pack" },
    });
    return updated;
  }
  if (!job?.fine_tuned_model_id) throw new Error("NO_MODEL");
  if (job.status !== "eval_pending") throw new Error("JOB_NOT_APPROVABLE");

  const now = new Date().toISOString();
  const evalResult =
    job.eval_result && typeof job.eval_result === "object"
      ? { ...(job.eval_result as Record<string, unknown>) }
      : {};
  const updated = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .update(t)
        .set({
          status: "approved",
          eval_result: {
            ...evalResult,
            manual_eval: { approved_by: userId, approved_at: now },
          },
        })
        .where(eq(t.id, jobId))
        .returning({ id: t.id, status: t.status, fine_tuned_model_id: t.fine_tuned_model_id })
    )
  );

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.FINETUNE_JOB_APPROVED,
    target_type: "model_training_job",
    target_id: jobId,
    payload: { job_id: jobId },
  });

  return updated;
}

export async function activateFineTunedModel(tenantId: string, userId: string, jobId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const mtj = tables.modelTrainingJobs;
  const settings = tables.tenantAiSettings;
  const job = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: mtj.id,
          status: mtj.status,
          provider: mtj.provider,
          base_model: mtj.base_model,
          fine_tuned_model_id: mtj.fine_tuned_model_id,
        })
        .from(mtj)
        .where(eq(mtj.id, jobId))
        .limit(1)
    )
  );
  if (!job) throw new Error("NOT_FOUND");
  if (job.provider === "gemini") {
    await setTenantModelDefaults(tenantId, {
      provider: "gemini",
      geminiModel: job.base_model || getDefaultGeminiModel(),
    });
    const now = new Date().toISOString();
    await enTenant(tenantCtx, (db) =>
      db
        .update(mtj)
        .set({ status: "deployed", activated_by: userId, activated_at: now })
        .where(and(eq(mtj.id, jobId), eq(mtj.provider, "gemini")))
    );
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userId,
      event_type: AuditEvent.FINETUNE_MODEL_DEPLOYED,
      target_type: "model_training_job",
      target_id: jobId,
      payload: { job_id: jobId, provider: "gemini", mode: "context_pack" },
    });
    return { model: job.base_model || getDefaultGeminiModel(), provider: "gemini" };
  }
  if (!job?.fine_tuned_model_id) throw new Error("NO_MODEL");
  if (job.status !== "approved") throw new Error("JOB_NOT_APPROVED");

  const current = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({ active_model: settings.active_model, openai_model: settings.openai_model })
        .from(settings)
        .limit(1)
    )
  );
  const previous = current?.active_model || current?.openai_model || getDefaultOpenAIModel();
  const now = new Date().toISOString();

  await db
    .insert(settings)
    .values({
      tenant_id: tenantId,
      provider: "openai",
      active_model_provider: "openai",
      active_model: job.fine_tuned_model_id,
      previous_model: previous,
      model_activated_by: userId,
      model_activated_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: settings.tenant_id,
      set: {
        provider: "openai",
        active_model_provider: "openai",
        active_model: job.fine_tuned_model_id,
        previous_model: previous,
        model_activated_by: userId,
        model_activated_at: now,
        updated_at: now,
      },
    });

  await enTenant(tenantCtx, (db) =>
    db
      .update(mtj)
      .set({ status: "deployed", activated_by: userId, activated_at: now })
      .where(eq(mtj.id, jobId))
  );

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.FINETUNE_MODEL_DEPLOYED,
    target_type: "model_training_job",
    target_id: jobId,
    payload: { job_id: jobId },
  });

  return { model: job.fine_tuned_model_id };
}

export async function rollbackFineTunedModel(tenantId: string, userId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const settings = tables.tenantAiSettings;
  const current = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({
          active_model: settings.active_model,
          previous_model: settings.previous_model,
          openai_model: settings.openai_model,
        })
        .from(settings)
        .limit(1)
    )
  );
  const rollbackTo = current?.previous_model || current?.openai_model || getDefaultOpenAIModel();
  const now = new Date().toISOString();
  await db
    .insert(settings)
    .values({
      tenant_id: tenantId,
      provider: "openai",
      active_model_provider: "openai",
      active_model: rollbackTo,
      previous_model: current?.active_model ?? null,
      model_activated_by: userId,
      model_activated_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: settings.tenant_id,
      set: {
        provider: "openai",
        active_model_provider: "openai",
        active_model: rollbackTo,
        previous_model: current?.active_model ?? null,
        model_activated_by: userId,
        model_activated_at: now,
        updated_at: now,
      },
    });

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.FINETUNE_MODEL_ROLLED_BACK,
    target_type: "tenant_ai_settings",
    target_id: tenantId,
    payload: {},
  });

  return { model: rollbackTo };
}
