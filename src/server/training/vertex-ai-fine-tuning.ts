/**
 * Vertex AI Gemini supervised fine-tuning pipeline for ClaimMix.
 *
 * Implements the full lifecycle:
 *   draft → start (GCS upload + Vertex AI tuning job) → sync → activate/rollback
 *
 * Does NOT call OpenAI. All external calls go to GCS and Vertex AI REST APIs,
 * authenticated via google-auth-library (Application Default Credentials or
 * GOOGLE_APPLICATION_CREDENTIALS service account file).
 *
 * Required env vars (server-side only, never sent to client):
 *   VERTEX_AI_TUNING_ENABLED   - must be "true" to allow any real operations
 *   GOOGLE_CLOUD_PROJECT       - GCP project ID
 *   GOOGLE_CLOUD_LOCATION      - e.g. "us-central1"
 *   GOOGLE_APPLICATION_CREDENTIALS - path to service account JSON (or use ADC)
 *   VERTEX_AI_GEMINI_BASE_MODEL    - e.g. "gemini-2.5-flash"
 *   VERTEX_AI_BUCKET_NAME          - GCS bucket for dataset uploads
 *   VERTEX_AI_MIN_EXAMPLES         - minimum approved examples (default 10)
 */

import "server-only";
import { createHash } from "crypto";
import { GoogleAuth } from "google-auth-library";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

// ── Configuration helpers ──────────────────────────────────────────────────

function isTuningEnabled(): boolean {
  return process.env.VERTEX_AI_TUNING_ENABLED === "true";
}

function getProject(): string {
  const v = process.env.GOOGLE_CLOUD_PROJECT;
  if (!v) throw new Error("GOOGLE_CLOUD_PROJECT is not set");
  return v;
}

function getLocation(): string {
  const v = process.env.GOOGLE_CLOUD_LOCATION;
  if (!v) throw new Error("GOOGLE_CLOUD_LOCATION is not set");
  return v;
}

function getBaseModel(): string {
  const v = process.env.VERTEX_AI_GEMINI_BASE_MODEL;
  if (!v) throw new Error("VERTEX_AI_GEMINI_BASE_MODEL is not set");
  return v;
}

function getBucket(): string {
  const v = process.env.VERTEX_AI_BUCKET_NAME;
  if (!v) throw new Error("VERTEX_AI_BUCKET_NAME is not set");
  return v;
}

function getMinExamples(): number {
  const raw = process.env.VERTEX_AI_MIN_EXAMPLES;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 10;
}

// ── Auth helper ────────────────────────────────────────────────────────────

let _auth: GoogleAuth | null = null;

function getGoogleAuth(): GoogleAuth {
  if (!_auth) {
    _auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }
  return _auth;
}

async function getAccessToken(): Promise<string> {
  const auth = getGoogleAuth();
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
  if (!token) throw new Error("Failed to obtain Google access token");
  return token;
}

// ── Vertex AI state mapping ────────────────────────────────────────────────

function mapVertexAiStatus(vertexState: string): string {
  if (
    vertexState === "JOB_STATE_PENDING" ||
    vertexState === "JOB_STATE_QUEUED"
  ) {
    return "queued";
  }
  if (vertexState === "JOB_STATE_RUNNING") return "running";
  if (vertexState === "JOB_STATE_SUCCEEDED") return "eval_pending";
  if (
    vertexState === "JOB_STATE_FAILED" ||
    vertexState === "JOB_STATE_CANCELLED" ||
    vertexState === "JOB_STATE_CANCELLING"
  ) {
    return "failed";
  }
  // Default: treat as queued for unknown transient states
  return "queued";
}

// ── JSONL construction ─────────────────────────────────────────────────────

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildExpectedOutput(
  expectedOutput: Record<string, unknown>
): Record<string, unknown> {
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

/**
 * Converts a single training example into a Vertex AI Gemini supervised-tuning
 * JSONL line.
 *
 * Vertex AI Gemini tuning requires the GenerateContent dataset format:
 *   { "systemInstruction": { "role": "system", "parts": [{ "text": ... }] },
 *     "contents": [ { "role": "user",  "parts": [{ "text": ... }] },
 *                   { "role": "model", "parts": [{ "text": ... }] } ] }
 *
 * It does NOT accept the OpenAI ChatCompletions `{ messages: [{ role, content }] }`
 * shape — uploading that fails the tuning job with:
 *   "Converting from 'ChatCompletions' to 'GenerateContent' dataset format is
 *    currently not supported for this model."
 * (observed on tuningJob 9110414817876770816, baseModel gemini-2.5-flash).
 */
function toGeminiJsonlLine(example: {
  input_payload: Record<string, unknown>;
  expected_output: Record<string, unknown>;
}): string {
  const subject =
    typeof example.input_payload.subject === "string"
      ? example.input_payload.subject
      : "";
  const body =
    typeof example.input_payload.body === "string"
      ? example.input_payload.body
      : "";
  return JSON.stringify({
    systemInstruction: {
      role: "system",
      parts: [
        {
          text: "You are the ClaimMix claim intake agent. Return only valid JSON matching the production extraction schema.",
        },
      ],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: `Subject: ${subject}\n\nBody:\n${body}` }],
      },
      {
        // Gemini tuning uses the "model" role for the expected assistant turn.
        role: "model",
        parts: [{ text: JSON.stringify(buildExpectedOutput(example.expected_output)) }],
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

/**
 * Builds Gemini-format training and validation JSONL content.
 * Exported so callers (e.g. admin UI preview) can inspect it.
 */
export async function buildVertexAiJsonl(tenantId: string) {
  const examples = await approvedExamplesForTenant(tenantId);
  const lines = examples.map(toGeminiJsonlLine);
  const validationCount =
    lines.length >= 10 ? Math.max(1, Math.floor(lines.length * 0.2)) : 0;
  const validation = validationCount > 0 ? lines.slice(0, validationCount) : [];
  const training = validationCount > 0 ? lines.slice(validationCount) : lines;
  return {
    trainingJsonl: training.join("\n") + "\n",
    validationJsonl: validation.length > 0 ? validation.join("\n") + "\n" : "",
    trainingCount: training.length,
    validationCount: validation.length,
  };
}

// ── GCS upload ─────────────────────────────────────────────────────────────

/**
 * Uploads JSONL content to GCS using the GCS JSON API with bearer-token auth.
 * Returns the GCS URI: gs://BUCKET/OBJECT_PATH
 */
async function uploadToGcs(
  bucket: string,
  objectPath: string,
  content: string,
  token: string
): Promise<string> {
  const encodedPath = encodeURIComponent(objectPath);
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodedPath}`;

  // GCS JSON API simple media upload requires POST. PUT on this endpoint returns
  // 404 (no matching route) — confirmed against the live bucket 2026-06-30.
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/jsonl",
      "Content-Length": String(Buffer.byteLength(content, "utf8")),
    },
    body: content,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "(no body)");
    throw new Error(
      `GCS upload failed [${response.status}]: ${errBody.slice(0, 200)}`
    );
  }

  return `gs://${bucket}/${objectPath}`;
}

// ── Vertex AI tuning job REST calls ───────────────────────────────────────

interface VertexTuningJobResponse {
  name?: string;
  state?: string;
  tunedModelDisplayName?: string;
  tunedModel?: {
    model?: string;
    modelVersionId?: string;
    endpoints?: { deployedModel?: string }[];
  };
  error?: { message?: string; code?: number };
}

async function createVertexTuningJob(
  project: string,
  location: string,
  baseModel: string,
  trainingUri: string,
  validationUri: string | null,
  token: string
): Promise<VertexTuningJobResponse> {
  const url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/tuningJobs`;

  const body: Record<string, unknown> = {
    baseModel,
    supervisedTuningSpec: {
      trainingDatasetUri: trainingUri,
      ...(validationUri ? { validationDatasetUri: validationUri } : {}),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "(no body)");
    throw new Error(
      `Vertex AI create tuning job failed [${response.status}]: ${errBody.slice(0, 300)}`
    );
  }

  return (await response.json()) as VertexTuningJobResponse;
}

async function getVertexTuningJob(
  project: string,
  location: string,
  vertexJobId: string,
  token: string
): Promise<VertexTuningJobResponse> {
  const url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/tuningJobs/${vertexJobId}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "(no body)");
    throw new Error(
      `Vertex AI get tuning job failed [${response.status}]: ${errBody.slice(0, 300)}`
    );
  }

  return (await response.json()) as VertexTuningJobResponse;
}

/** Extracts the short numeric job ID from a Vertex AI resource name. */
function extractVertexJobId(resourceName: string | undefined): string | null {
  if (!resourceName) return null;
  // Format: projects/PROJECT/locations/LOCATION/tuningJobs/JOB_ID
  const parts = resourceName.split("/");
  return parts[parts.length - 1] ?? null;
}

// ── Public pipeline functions ──────────────────────────────────────────────

/**
 * Creates a draft Vertex AI tuning job record in the DB.
 * Validates that enough approved examples exist before creating.
 */
export async function createVertexAiTuningDraft(
  tenantId: string,
  userId: string
) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  if (!isTuningEnabled()) {
    throw new Error("VERTEX_AI_TUNING_DISABLED");
  }

  const examples = await approvedExamplesForTenant(tenantId);
  const minExamples = getMinExamples();
  if (examples.length < minExamples) {
    throw new Error(
      `NOT_ENOUGH_EXAMPLES:${minExamples}`
    );
  }

  const t = tables.modelTrainingJobs;

  // Block if an open Vertex AI job already exists for this tenant
  const OPEN_JOB_STATUSES = ["draft", "queued", "running", "eval_pending", "approved"];
  const existing = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            eq(t.provider, "vertex_ai_gemini"),
            inArray(t.status, OPEN_JOB_STATUSES)
          )
        )
        .limit(1)
    )
  );
  if (existing) return existing;

  const baseModel = getBaseModel();
  const job = firstRow(
    await db
      .insert(t)
      .values({
        tenant_id: tenantId,
        status: "draft",
        provider: "vertex_ai_gemini",
        base_model: baseModel,
        training_example_count: examples.length,
        created_by: userId,
      })
      .returning({ id: t.id, status: t.status, provider: t.provider })
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
      provider: "vertex_ai_gemini",
      training_example_count: examples.length,
    },
  });

  return job;
}

/**
 * Converts approved examples to Gemini JSONL, uploads to GCS, then calls
 * the Vertex AI tuning API to start the supervised fine-tuning job.
 */
export async function startVertexAiTuningJob(
  tenantId: string,
  userId: string,
  jobId: string
) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  if (!isTuningEnabled()) {
    throw new Error("VERTEX_AI_TUNING_DISABLED");
  }

  const t = tables.modelTrainingJobs;
  const job = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: t.id,
          status: t.status,
          provider: t.provider,
          base_model: t.base_model,
        })
        .from(t)
        .where(eq(t.id, jobId))
        .limit(1)
    )
  );
  if (!job) throw new Error("NOT_FOUND");
  if (job.provider !== "vertex_ai_gemini") throw new Error("WRONG_PROVIDER");
  if (!["draft", "failed"].includes(job.status)) throw new Error("JOB_NOT_STARTABLE");

  const jsonl = await buildVertexAiJsonl(tenantId);
  const minExamples = getMinExamples();
  if (jsonl.trainingCount < minExamples) {
    throw new Error(`NOT_ENOUGH_EXAMPLES:${minExamples}`);
  }

  const project = getProject();
  const location = getLocation();
  const bucket = getBucket();
  const baseModel = job.base_model || getBaseModel();
  const timestamp = Date.now();

  // Get auth token once for all GCS + Vertex AI calls
  const token = await getAccessToken();

  // Upload training JSONL
  const trainPath = `${tenantId}/train_${timestamp}.jsonl`;
  const trainingUri = await uploadToGcs(bucket, trainPath, jsonl.trainingJsonl, token);

  // Upload validation JSONL (if we have enough examples for a split)
  let validationUri: string | null = null;
  if (jsonl.validationJsonl) {
    const valPath = `${tenantId}/val_${timestamp}.jsonl`;
    validationUri = await uploadToGcs(bucket, valPath, jsonl.validationJsonl, token);
  }

  // Create the Vertex AI tuning job
  const vertexJob = await createVertexTuningJob(
    project,
    location,
    baseModel,
    trainingUri,
    validationUri,
    token
  );

  const vertexJobId = extractVertexJobId(vertexJob.name);
  const mappedStatus = vertexJob.state
    ? mapVertexAiStatus(vertexJob.state)
    : "queued";

  const updated = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .update(t)
        .set({
          status: mappedStatus,
          // Reuse openai_fine_tuning_job_id for the Vertex AI job resource name
          openai_fine_tuning_job_id: vertexJob.name ?? vertexJobId,
          // Reuse training_file_id / validation_file_id for GCS URIs
          training_file_id: trainingUri,
          validation_file_id: validationUri,
          training_jsonl: jsonl.trainingJsonl,
          validation_jsonl: jsonl.validationJsonl || null,
          training_example_count: jsonl.trainingCount + jsonl.validationCount,
          eval_result: {
            vertex_job_name: vertexJob.name,
            vertex_state: vertexJob.state,
            validation_count: jsonl.validationCount,
          },
          error_message: null,
          started_at: new Date().toISOString(),
        })
        .where(eq(t.id, jobId))
        .returning({ id: t.id, status: t.status })
    )
  );

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.FINETUNE_JOB_STARTED,
    target_type: "model_training_job",
    target_id: jobId,
    payload: {
      job_id: jobId,
      vertex_job_name: vertexJob.name,
      training_gcs_uri: trainingUri,
      validation_gcs_uri: validationUri ?? undefined,
    },
  });

  return updated;
}

/**
 * Polls Vertex AI for the current tuning job state and updates the DB record.
 */
export async function syncVertexAiTuningJobStatus(
  tenantId: string,
  userId: string,
  jobId: string
) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  if (!isTuningEnabled()) {
    throw new Error("VERTEX_AI_TUNING_DISABLED");
  }

  const t = tables.modelTrainingJobs;
  const job = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: t.id,
          provider: t.provider,
          status: t.status,
          openai_fine_tuning_job_id: t.openai_fine_tuning_job_id,
          eval_result: t.eval_result,
        })
        .from(t)
        .where(eq(t.id, jobId))
        .limit(1)
    )
  );
  if (!job) throw new Error("NOT_FOUND");
  if (job.provider !== "vertex_ai_gemini") throw new Error("WRONG_PROVIDER");

  // openai_fine_tuning_job_id stores the full Vertex AI resource name
  const vertexJobName = job.openai_fine_tuning_job_id;
  if (!vertexJobName) throw new Error("VERTEX_JOB_NOT_STARTED");

  const project = getProject();
  const location = getLocation();
  const vertexJobId = extractVertexJobId(vertexJobName);
  if (!vertexJobId) throw new Error("INVALID_VERTEX_JOB_NAME");

  const token = await getAccessToken();
  const vertexJob = await getVertexTuningJob(project, location, vertexJobId, token);

  const mappedStatus = vertexJob.state
    ? mapVertexAiStatus(vertexJob.state)
    : job.status;

  const isTerminal =
    mappedStatus === "eval_pending" || mappedStatus === "failed";

  // Extract the tuned model endpoint from the Vertex AI response.
  // When SUCCEEDED, tunedModel.model holds the tuned model resource name.
  const tunedModelId =
    vertexJob.tunedModel?.model ??
    vertexJob.tunedModel?.endpoints?.[0]?.deployedModel ??
    null;

  const existingEval =
    job.eval_result && typeof job.eval_result === "object"
      ? { ...(job.eval_result as Record<string, unknown>) }
      : {};

  const updated = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .update(t)
        .set({
          status: mappedStatus,
          fine_tuned_model_id: tunedModelId,
          error_message: vertexJob.error?.message ?? null,
          eval_result: {
            ...existingEval,
            vertex_state: vertexJob.state,
            vertex_error: vertexJob.error ?? null,
            tuned_model: vertexJob.tunedModel ?? null,
          },
          completed_at: isTerminal ? new Date().toISOString() : null,
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
    payload: {
      job_id: jobId,
      vertex_state: vertexJob.state,
      mapped_status: mappedStatus,
    },
  });

  return updated;
}

/**
 * After the tuning job succeeds and an admin approves the evaluation, activates
 * the tuned model by updating tenantAiSettings to use the new endpoint.
 */
export async function activateVertexAiModel(
  tenantId: string,
  userId: string,
  jobId: string
) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  if (!isTuningEnabled()) {
    throw new Error("VERTEX_AI_TUNING_DISABLED");
  }

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
  if (job.provider !== "vertex_ai_gemini") throw new Error("WRONG_PROVIDER");
  if (!job.fine_tuned_model_id) throw new Error("NO_MODEL");
  if (job.status !== "approved") throw new Error("JOB_NOT_APPROVED");

  // Read the current active model for rollback tracking
  const current = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({
          active_model: settings.active_model,
          gemini_model: settings.gemini_model,
        })
        .from(settings)
        .limit(1)
    )
  );
  const previous =
    current?.active_model || current?.gemini_model || job.base_model;

  const now = new Date().toISOString();
  const tunedModelId = job.fine_tuned_model_id;

  // Upsert tenantAiSettings to point at the new tuned model
  await db
    .insert(settings)
    .values({
      tenant_id: tenantId,
      provider: "gemini",
      active_model_provider: "gemini",
      active_model: tunedModelId,
      previous_model: previous,
      model_activated_by: userId,
      model_activated_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: settings.tenant_id,
      set: {
        provider: "gemini",
        active_model_provider: "gemini",
        active_model: tunedModelId,
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
    payload: {
      job_id: jobId,
      provider: "vertex_ai_gemini",
      tuned_model_id: tunedModelId,
    },
  });

  return { model: tunedModelId, provider: "vertex_ai_gemini" as const };
}

/**
 * Reverts tenantAiSettings.gemini_model (active_model) to previous_model.
 */
export async function rollbackVertexAiModel(tenantId: string, userId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const settings = tables.tenantAiSettings;

  const current = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({
          active_model: settings.active_model,
          previous_model: settings.previous_model,
          gemini_model: settings.gemini_model,
        })
        .from(settings)
        .limit(1)
    )
  );

  const rollbackTo =
    current?.previous_model ||
    current?.gemini_model ||
    process.env.VERTEX_AI_GEMINI_BASE_MODEL ||
    "gemini-2.5-flash";

  const now = new Date().toISOString();

  await db
    .insert(settings)
    .values({
      tenant_id: tenantId,
      provider: "gemini",
      active_model_provider: "gemini",
      active_model: rollbackTo,
      previous_model: current?.active_model ?? null,
      model_activated_by: userId,
      model_activated_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: settings.tenant_id,
      set: {
        provider: "gemini",
        active_model_provider: "gemini",
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
    payload: {
      rolled_back_to: rollbackTo,
      provider: "vertex_ai_gemini",
    },
  });

  return { model: rollbackTo };
}

/**
 * Lists all Vertex AI training jobs for a tenant, newest first.
 */
export async function listVertexAiTuningJobs(tenantId: string) {
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
        error_message: t.error_message,
        training_example_count: t.training_example_count,
        eval_result: t.eval_result,
        created_at: t.created_at,
        started_at: t.started_at,
        completed_at: t.completed_at,
        activated_at: t.activated_at,
      })
      .from(t)
      .where(
        eq(t.provider, "vertex_ai_gemini")
      )
      .orderBy(desc(t.created_at))
      .limit(50)
  );
}

/**
 * Returns a single Vertex AI tuning job by ID (tenant-scoped).
 */
export async function getVertexAiTuningJob(tenantId: string, jobId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const t = tables.modelTrainingJobs;
  return firstRow(
    await enTenant(tenantCtx, (db) =>
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
        .where(
          and(
            eq(t.id, jobId),
            eq(t.provider, "vertex_ai_gemini")
          )
        )
        .limit(1)
    )
  );
}

/**
 * Returns current Vertex AI configuration for display in the admin UI.
 * Never returns credentials or sensitive values.
 * Returns null when the integration is not fully configured.
 */
export function getVertexAiConfig(): {
  enabled: boolean;
  project: string;
  location: string;
  base_model: string;
  bucket: string;
  min_examples: number;
} | null {
  const enabled = isTuningEnabled();
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? "";
  const base_model = process.env.VERTEX_AI_GEMINI_BASE_MODEL ?? "";
  const bucket = process.env.VERTEX_AI_BUCKET_NAME ?? "";

  if (!project || !location || !base_model || !bucket) return null;

  return {
    enabled,
    project,
    location,
    base_model,
    bucket,
    min_examples: getMinExamples(),
  };
}
