/**
 * El paquete de entrenamiento del agente.
 *
 * Ya no hay trabajos que se suban a un proveedor. La API pública de Gemini no
 * expone fine-tuning, así que lo que arma esto es un PAQUETE DE CONTEXTO: el
 * JSONL de los ejemplos aprobados más su metadata, para respaldo, evaluación y
 * para poder llevarse la memoria del agente a otro lado. El fine-tuning de
 * verdad vive en `vertex-ai-fine-tuning.ts`, que sí llama a Google.
 *
 * ── Qué se fue con OpenAI ───────────────────────────────────────────────────
 *
 * `sync` desapareció porque con un solo proveedor hacía exactamente lo mismo
 * que `start`: rearmar el paquete. Dos botones para la misma acción.
 *
 * `approve` desapareció porque el paquete nace `approved` — no hay nada que
 * esperar cuando no se subió nada a ningún lado. Era el paso que servía para
 * mirar la evaluación de OpenAI antes de activar.
 *
 * `rollback` desapareció y es el único que cambia algo que se podía hacer: era
 * enteramente de OpenAI —escribía `provider: "openai"` en la configuración del
 * inquilino— así que dejarlo habría sido dejar un botón que guarda un valor
 * que el producto ya no sabe leer.
 */


import "server-only";
import { createHash } from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";

import { tables } from "@/lib/db";
import {
  approvedExamplesForTenant,
  buildExpectedOutput,
} from "@/server/training/dataset";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import {
  getDefaultGeminiModel,
  getTenantGeminiModel,
  setTenantModelDefaults,
} from "@/server/ai/provider";

const OPEN_JOB_STATUSES = ["draft", "queued", "running", "eval_pending", "approved"];

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
        await enTenant(tenantCtx, (db) =>
          db
            .insert(t)
            .values({
              tenant_id: tenantId,
              created_by: userId,
              ...values,
            })
            .returning({ id: t.id })
        )
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

export async function createDraftFineTuneJob(tenantId: string, userId: string) {
  const examples = await approvedExamplesForTenant(tenantId);
  if (examples.length < 1) throw new Error("NO_APPROVED_EXAMPLES");
  return createOrRefreshGeminiContextJob(tenantId, userId);
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

/**
 * Rearmar el paquete con los ejemplos aprobados de hoy.
 *
 * La pantalla lo llama «Actualizar», y es lo único que hace: no hay un trabajo
 * corriendo del otro lado al que preguntarle cómo va.
 */
export async function startFineTuneJob(tenantId: string, userId: string, jobId: string) {
  const t = tables.modelTrainingJobs;
  const job = firstRow(
    await enTenant({ tenantId }, (db) =>
      db.select({ id: t.id }).from(t).where(eq(t.id, jobId)).limit(1)
    )
  );
  if (!job) throw new Error("NOT_FOUND");
  return createOrRefreshGeminiContextJob(tenantId, userId, jobId);
}


export async function activateFineTunedModel(tenantId: string, userId: string, jobId: string) {
  const tenantCtx: TenantContext = { tenantId };
  const mtj = tables.modelTrainingJobs;
  const job = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({ id: mtj.id, base_model: mtj.base_model })
        .from(mtj)
        .where(eq(mtj.id, jobId))
        .limit(1)
    )
  );
  if (!job) throw new Error("NOT_FOUND");

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
