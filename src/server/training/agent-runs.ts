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
import type { SupabaseClient } from "@supabase/supabase-js";
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
  supabase: SupabaseClient,
  params: LogAgentRunParams
): Promise<string | null> {
  const { claim, trainability } = params;

  const modelProvider = claim.extraction_model?.startsWith("mock")
    ? "mock"
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
    trainability_score: trainability.trainabilityScore,
    trainability_reasons: trainability.trainabilityReasons,
    blocking_reasons: trainability.blockingReasons,
  };

  try {
    const { data, error } = await (supabase as any)
      .from("agent_runs")
      .insert(row)
      .select("id")
      .single();

    if (error || !data) {
      // 42P01 = table missing (migration not applied yet) — degrade silently
      // so existing deployments keep extracting.
      if (error?.code !== "42P01") {
        console.error("[agent-runs] insert error:", error?.code ?? "no_data"); // crew-debug-ok
      }
      return null;
    }

    return (data as { id: string }).id;
  } catch {
    // Never break the extraction pipeline because run logging failed.
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
 * Fetch the most recent agent run for a case (tenant scoping enforced by the
 * caller's client — pass a user-scoped client for RLS, service for workers).
 */
export async function getLatestAgentRun(
  supabase: SupabaseClient,
  caseId: string
): Promise<AgentRunRow | null> {
  try {
    const { data, error } = await (supabase as any)
      .from("agent_runs")
      .select(
        "id,case_id,claim_message_id,provider_message_id,model_provider,model_name,prompt_version,input_payload,output_payload,confidence_payload,missing_fields,is_trainable_suggestion,trainability_score,trainability_reasons,blocking_reasons,created_at"
      )
      .eq("case_id", caseId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      if (error && error.code !== "42P01") {
        console.error("[agent-runs] latest fetch error:", error.code); // crew-debug-ok
      }
      return null;
    }

    return data as AgentRunRow;
  } catch {
    return null;
  }
}
