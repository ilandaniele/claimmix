/**
 * agent_runs logging — one row per processed email.
 *
 * Stores what the agent saw (input_payload), what it produced (output_payload),
 * per-field confidence, missing fields, and the trainability suggestion.
 * Append-only; written with the service-role client from the extraction worker.
 *
 * The raw email content lives in input_payload (jsonb) — protected by tenant
 * RLS, required by the review workflow so a human can audit exactly what the
 * model was shown before approving a training example.
 *
 * LLM06: log lines contain only ids/error codes — never payload content.
 */

import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { getDefaultGeminiModel } from "@/server/ai/provider";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { TrainabilityAssessment } from "./trainability";

export interface LogAgentRunParams {
  tenantId: string;
  caseId: string | null;
  claimMessageId?: string | null;
  providerMessageId?: string | null;
  modelName: string;
  promptVersionId?: string | null;
  promptVersion: string;
  input: {
    subject: string;
    body: string;
    sender_email?: string;
  };
  claim: ExtractedClaim;
  trainability: TrainabilityAssessment;
}

/**
 * Insert an agent_runs row. Non-fatal: returns the new row id, or null when
 * the insert fails (extraction pipeline must never break on logging).
 */
export async function logAgentRun(
  params: LogAgentRunParams
): Promise<string | null> {
  const { claim, trainability } = params;

  const modelProvider = claim.extraction_model?.startsWith("mock")
    ? "mock"
    : claim.extraction_model?.startsWith("gemini")
      ? "gemini"
      : "openai";

  // Output payload: full validated extractor output. Token/cost metadata is
  // useful for review; PII inside is tenant-RLS-protected like claim_messages.
  const row = {
    tenant_id: params.tenantId,
    case_id: params.caseId,
    claim_message_id: params.claimMessageId ?? null,
    provider_message_id: params.providerMessageId ?? null,
    model_provider: modelProvider,
    model_name: params.modelName,
    prompt_version_id: params.promptVersionId ?? null,
    prompt_version: params.promptVersion,
    input_payload: {
      subject: params.input.subject,
      body: params.input.body,
      sender_email: params.input.sender_email ?? null,
    },
    output_payload: claim,
    confidence_payload: {
      confidence: claim.confidence,
      field_confidences: claim.field_confidences ?? {},
      fields: (claim.fields ?? []).map((f) => ({
        field_key: f.field_key,
        confidence: f.confidence,
        source: f.source,
      })),
    },
    missing_fields: claim.missing_fields ?? [],
    is_trainable_suggestion: trainability.isTrainableSuggestion,
    trainability_score: trainability.trainabilityScore.toString(),
    trainability_reasons: trainability.trainabilityReasons,
    blocking_reasons: trainability.blockingReasons,
  };

  try {
    const data = firstRow(
      await db
        .insert(tables.agentRuns)
        .values(row)
        .returning({ id: tables.agentRuns.id })
    );

    if (!data) {
      console.error("[agent-runs] insert error:", "no_data"); // crew-debug-ok
      return null;
    }

    return data.id;
  } catch (e) {
    // 42P01 = table missing (migration not applied yet) — degrade silently
    // so existing deployments keep extracting.
    const code = (e as { code?: string })?.code;
    if (code !== "42P01") {
      console.error("[agent-runs] insert error:", code ?? "no_data"); // crew-debug-ok
    }
    // Never break the extraction pipeline because run logging failed.
    return null;
  }
}

export interface LogAgentRunErrorParams {
  tenantId: string;
  caseId: string | null;
  claimMessageId?: string | null;
  providerMessageId?: string | null;
  modelName?: string;
  input: {
    subject: string;
    body: string;
    sender_email?: string;
  };
  errorName: string;
  /** HTTP status from the provider (e.g. 429), when known. */
  errorStatus?: number | null;
  /** Provider error code (e.g. "RESOURCE_EXHAUSTED"), when known. */
  errorCode?: string | null;
}

/**
 * Insert a failed agent_runs row when the provider throws before extraction
 * completes. Makes the failure visible in the training panel and audit trail
 * without requiring a successful ExtractedClaim.
 */
export async function logAgentRunError(
  params: LogAgentRunErrorParams
): Promise<string | null> {
  const row = {
    tenant_id: params.tenantId,
    case_id: params.caseId,
    claim_message_id: params.claimMessageId ?? null,
    provider_message_id: params.providerMessageId ?? null,
    model_provider: "gemini",
    // Fall back to the configured model, not a bare "gemini" — the generic name
    // made provider failures look like a model-resolution bug when they weren't.
    model_name: params.modelName ?? getDefaultGeminiModel(),
    prompt_version: "builtin-v1",
    input_payload: {
      subject: params.input.subject,
      body: params.input.body,
      sender_email: params.input.sender_email ?? null,
    },
    // Persist the real provider status/code (e.g. 429 / RESOURCE_EXHAUSTED) so the
    // root cause is visible in the DB, not only in Vercel logs.
    output_payload: {
      error: "provider_error",
      error_name: params.errorName,
      error_status: params.errorStatus ?? null,
      error_code: params.errorCode ?? null,
    },
    confidence_payload: {},
    missing_fields: [],
    is_trainable_suggestion: false,
    trainability_score: "0",
    trainability_reasons: [],
    blocking_reasons: ["provider_error"],
  };

  try {
    const data = firstRow(
      await db
        .insert(tables.agentRuns)
        .values(row)
        .returning({ id: tables.agentRuns.id })
    );
    return data?.id ?? null;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code !== "42P01") {
      console.error("[agent-runs] error-run insert error:", code ?? "no_data"); // crew-debug-ok
    }
    return null;
  }
}

/** Shape returned by getLatestAgentRun — everything the preview UI needs. */
export interface AgentRunRow {
  id: string;
  case_id: string | null;
  claim_message_id: string | null;
  provider_message_id: string | null;
  model_provider: string;
  model_name: string;
  prompt_version: string;
  input_payload: { subject?: string; body?: string; sender_email?: string | null };
  output_payload: ExtractedClaim;
  confidence_payload: Record<string, unknown>;
  missing_fields: string[];
  is_trainable_suggestion: boolean;
  trainability_score: number;
  trainability_reasons: string[];
  blocking_reasons: string[];
  created_at: string;
}

/**
 * Fetch the most recent agent run for a case. Tenant scoping is enforced
 * explicitly (RLS is gone): pass the tenant id from the authenticated context.
 */
export async function getLatestAgentRun(
  tenantId: string,
  caseId: string
): Promise<AgentRunRow | null> {
  try {
    const t = tables.agentRuns;
    const data = firstRow(
      await db
        .select({
          id: t.id,
          case_id: t.case_id,
          claim_message_id: t.claim_message_id,
          provider_message_id: t.provider_message_id,
          model_provider: t.model_provider,
          model_name: t.model_name,
          prompt_version: t.prompt_version,
          input_payload: t.input_payload,
          output_payload: t.output_payload,
          confidence_payload: t.confidence_payload,
          missing_fields: t.missing_fields,
          is_trainable_suggestion: t.is_trainable_suggestion,
          trainability_score: t.trainability_score,
          trainability_reasons: t.trainability_reasons,
          blocking_reasons: t.blocking_reasons,
          created_at: t.created_at,
        })
        .from(t)
        .where(and(eq(t.tenant_id, tenantId), eq(t.case_id, caseId)))
        .orderBy(desc(t.created_at))
        .limit(1)
    );

    if (!data) return null;

    // numeric columns surface as strings — convert to keep the JSON shape
    // identical to the previous PostgREST response.
    return {
      ...data,
      trainability_score: Number(data.trainability_score),
    } as AgentRunRow;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code && code !== "42P01") {
      console.error("[agent-runs] latest fetch error:", code); // crew-debug-ok
    }
    return null;
  }
}
