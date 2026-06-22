/**
 * OpenAI-based claim extractor.
 *
 * LLM01: System prompt uses XML sentinel delimiters (<claim_text> for simulate flow;
 *        <email_subject> + <email_body> for email intake — AC25).
 * LLM02: response_format with json_schema strict=true.
 * LLM06: Logs only case_id and token counts — NEVER raw_intake_text or PII.
 * LLM07: Service role client used server-side; service role key never in prompt.
 * LLM08: Model cannot set case.status (FSM enforced in worker).
 *
 * Retry policy: one retry with a stricter prompt on invalid JSON.
 * After retry failure → throws OpenAIExtractionError (worker escalates the case).
 *
 * AC17: AI output validated against ExtractedClaimSchema before any DB write.
 * W3:   extractEmailClaim() — new function for email intake pipeline.
 */

import "server-only";
import OpenAI from "openai";
import { ExtractedClaimSchema, OPENAI_JSON_SCHEMA } from "@/lib/schemas/extracted-claim";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { ClaimType } from "@/lib/schemas/cases";
import { buildSystemPrompt, buildUserMessage, buildEmailClaimPrompt } from "./prompt";
import type { MemoryHint, KnownPattern, PromptLearningContext } from "./prompt";
import { computeCostUsd, recordUsage } from "./budget";
import { getDefaultOpenAIModel, getTenantOpenAIModel } from "./provider";

/** Custom error for unrecoverable AI extraction failures. */
export class OpenAIExtractionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OpenAIExtractionError";
  }
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new OpenAIExtractionError(
        "OPENAI_API_KEY is not set. Set MOCK_AI=true to use the mock extractor."
      );
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

/** Returns the configured OpenAI model. Override with OPENAI_MODEL env var. */
function getModel(): string {
  return getDefaultOpenAIModel();
}

/**
 * Extract balanced JSON object candidates from a model response.
 *
 * Gemini can occasionally wrap otherwise valid JSON in prose, markdown fences,
 * or a small reasoning object before the final answer. Each candidate is still
 * validated with Zod before use; this only makes parsing tolerant to formatting
 * noise from the transport/model layer.
 */
export function extractJsonObjectTexts(content: string | null): string[] {
  if (!content) return [];
  const trimmed = content.trim();
  if (!trimmed) return [];

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const text = (fenced?.[1] ?? trimmed).trim();
  const candidates: string[] = [];

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === "{") depth++;
      if (char === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          start = i;
          break;
        }
      }
    }
  }

  return candidates;
}

/**
 * Extract the first balanced JSON object from a model response.
 *
 * Kept for callers/tests that only need a single JSON object. Production parse
 * paths use extractJsonObjectTexts() and schema validation to choose the first
 * usable extraction object.
 */
export function extractJsonObjectText(content: string | null): string | null {
  return extractJsonObjectTexts(content)[0] ?? null;
}

function parseModelJsonCandidates(content: string | null): Record<string, unknown>[] {
  return extractJsonObjectTexts(content).flatMap((jsonText) => {
    try {
      const parsed = JSON.parse(jsonText);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? [parsed as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

function looksLikeExtractionCandidate(raw: Record<string, unknown>): boolean {
  return [
    "is_claim",
    "confidence",
    "extracted_fields",
    "fields",
    "missing_fields",
    "severity",
    "not_relevant_reason",
    "summary",
  ].some((key) => Object.prototype.hasOwnProperty.call(raw, key));
}

function withEmailDefaults(
  rawCandidate: Record<string, unknown>,
  model?: string
): Record<string, unknown> {
  const raw = { ...rawCandidate };
  if (!raw.extraction_model) raw.extraction_model = model ?? getModel();
  if (!Array.isArray(raw.fields)) raw.fields = [];
  if (!raw.field_confidences) raw.field_confidences = {};
  if (!Array.isArray(raw.missing_fields)) raw.missing_fields = [];
  if (!Array.isArray(raw.fields_pending_confirmation)) raw.fields_pending_confirmation = [];
  if (!Array.isArray(raw.possible_customer_matches)) raw.possible_customer_matches = [];
  if (!Array.isArray(raw.possible_policy_matches)) raw.possible_policy_matches = [];
  if (typeof raw.prompt_tokens !== "number") raw.prompt_tokens = 0;
  if (typeof raw.completion_tokens !== "number") raw.completion_tokens = 0;
  if (typeof raw.cost_usd !== "number") raw.cost_usd = 0;
  if (typeof raw.summary !== "string") raw.summary = "";
  if (typeof raw.suggested_reply !== "string") raw.suggested_reply = "";
  if (!raw.not_relevant_reason) raw.not_relevant_reason = undefined;
  return raw;
}

/**
 * Parse and validate the model response content as an ExtractedClaim.
 * Returns null if parsing or validation fails.
 * Exported for reuse by other providers (gemini-extractor).
 */
export function parseResponse(content: string | null, claimType: ClaimType, model?: string): ExtractedClaim | null {
  if (!content) return null;
  try {
    const candidates = parseModelJsonCandidates(content);
    let issueCount = 0;
    for (const rawCandidate of candidates) {
      const raw = { ...rawCandidate };
      if (!raw.extraction_model) raw.extraction_model = model ?? getModel();
      const parsed = ExtractedClaimSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      issueCount += parsed.error.issues.length;
    }

    if (candidates.length > 0) {
      console.error(
        "[openai-extractor] Schema validation failed:",
        issueCount,
        "issues across",
        candidates.length,
        "JSON candidate(s)"
      );
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run the OpenAI extractor for a single claim text.
 *
 * @param rawText   - Raw email body (full claim text).
 * @param claimType - Determines which fields to extract.
 * @param caseId    - Used for structured logging (never logged is the text itself).
 * @returns         - Validated ExtractedClaim with token usage and cost.
 * @throws          - OpenAIExtractionError if extraction fails after retry.
 */
export async function runOpenAIExtractor(
  rawText: string,
  claimType: ClaimType,
  caseId: string,
  tenantId?: string
): Promise<ExtractedClaim> {
  const client = getClient();
  const model = await getTenantOpenAIModel(tenantId);
  const systemPrompt = buildSystemPrompt(claimType);
  const userMessage = buildUserMessage(rawText);

  // ── Attempt 1 ─────────────────────────────────────────────────────────────
  let result: ExtractedClaim | null = null;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  try {
    const response = await client.chat.completions.create({
      model,
      response_format: OPENAI_JSON_SCHEMA,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
      max_tokens: 2048,
    });

    // LLM06: Log only case_id + token counts, NEVER the raw text.
    const usage = response.usage;
    totalPromptTokens = usage?.prompt_tokens ?? 0;
    totalCompletionTokens = usage?.completion_tokens ?? 0;
    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "ai.extraction.attempt1",
        case_id: caseId,
        model,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
      })
    );

    result = parseResponse(response.choices[0]?.message?.content ?? null, claimType, model);
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "ai.extraction.attempt1.error",
        case_id: caseId,
        error_name: name,
      })
    );
    // Fall through to retry.
  }

  if (result) {
    return {
      ...result,
      extraction_model: model,
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      cost_usd: computeCostUsd(totalPromptTokens, totalCompletionTokens, model),
    };
  }

  // ── Attempt 2 (retry with stricter prompt) ───────────────────────────────
  const stricterSystem =
    systemPrompt +
    "\n\nIMPORTANT: Your previous response was invalid JSON. Return ONLY valid JSON matching the schema exactly. No markdown, no code blocks, no extra text.";

  try {
    const retryResponse = await client.chat.completions.create({
      model,
      response_format: OPENAI_JSON_SCHEMA,
      messages: [
        { role: "system", content: stricterSystem },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
      max_tokens: 2048,
    });

    const retryUsage = retryResponse.usage;
    const retryPromptTokens = retryUsage?.prompt_tokens ?? 0;
    const retryCompletionTokens = retryUsage?.completion_tokens ?? 0;
    totalPromptTokens += retryPromptTokens;
    totalCompletionTokens += retryCompletionTokens;

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "ai.extraction.attempt2",
        case_id: caseId,
        model,
        prompt_tokens: retryPromptTokens,
        completion_tokens: retryCompletionTokens,
      })
    );

    result = parseResponse(retryResponse.choices[0]?.message?.content ?? null, claimType, model);
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "ai.extraction.attempt2.error",
        case_id: caseId,
        error_name: name,
      })
    );
  }

  if (result) {
    return {
      ...result,
      extraction_model: model,
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      cost_usd: computeCostUsd(totalPromptTokens, totalCompletionTokens, model),
    };
  }

  // Both attempts failed — worker will escalate the case.
  throw new OpenAIExtractionError(
    `AI extraction failed after 2 attempts for case ${caseId}`
  );
}

// ── Email claim extractor (W3) ─────────────────────────────────────────────────

/**
 * Payload for the email claim extractor.
 */
export interface EmailClaimPayload {
  subject: string;
  body: string;
  memoryHints: MemoryHint[];
  knownPatterns: KnownPattern[];
  senderEmail?: string;
  agentTraining?: string;
  /** Operator learning context: rules, approved examples, versioned prompt. */
  learning?: PromptLearningContext;
}

/**
 * Extract structured claim data from an inbound email using OpenAI.
 *
 * This is the primary entry point for the email intake pipeline (W3).
 * It handles both is_claim detection and field extraction in a single LLM call.
 *
 * LLM01: Subject and body are isolated in XML sentinel tags by buildEmailClaimPrompt.
 * LLM02: Output validated against ExtractedClaimSchema before any DB write.
 * LLM06: Logs only caseId/token counts — never raw email body or PII.
 * LLM10: Budget tracked via ai_usage row with endpoint='email_claim_extraction'.
 * AC25: XML sentinels prevent prompt injection from email content.
 *
 * On parse error: returns safe default { is_claim: false, confidence: 0, ... }
 * On OpenAI error: logs + rethrows (caller handles retry).
 *
 * @param payload - Email subject, body, memory hints, known patterns, sender email.
 * @param tenantId - Tenant ID for budget tracking (optional for non-tenant contexts).
 * @param caseId   - Case ID for structured logging (never logged as the email body).
 */
export async function extractEmailClaim(
  payload: EmailClaimPayload,
  tenantId?: string,
  caseId?: string
): Promise<ExtractedClaim> {
  const client = getClient();
  const model = await getTenantOpenAIModel(tenantId);
  const logCaseId = caseId ?? "unknown";
  const logTenantId = tenantId ?? "unknown";

  // Build the email-specific prompt (LLM01 XML sentinels — AC25).
  const systemPrompt = buildEmailClaimPrompt(
    payload.subject,
    payload.body,
    payload.memoryHints,
    payload.knownPatterns,
    payload.senderEmail,
    payload.agentTraining,
    payload.learning
  );

  // User message is minimal — all content is in the system prompt via XML tags.
  const userMessage = "Analyze the email provided in the system prompt and return the structured JSON extraction.";

  let result: ExtractedClaim | null = null;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  // ── Attempt 1 ─────────────────────────────────────────────────────────────
  try {
    const response = await client.chat.completions.create({
      model,
      response_format: OPENAI_JSON_SCHEMA,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage },
      ],
      temperature: 0,
      max_tokens: 2048,
    });

    const usage = response.usage;
    totalPromptTokens = usage?.prompt_tokens ?? 0;
    totalCompletionTokens = usage?.completion_tokens ?? 0;

    // LLM06: Log only metadata — never the raw email body.
    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "ai.email_extraction.attempt1",
        case_id: logCaseId,
        tenant_id: logTenantId,
        model,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
      })
    );

    result = parseEmailResponse(response.choices[0]?.message?.content ?? null, model);
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    const apiErr = e as { status?: number; code?: string };
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "ai.email_extraction.attempt1.error",
        case_id: logCaseId,
        error_name: name,
        status: apiErr?.status ?? null,
        code: apiErr?.code ?? null,
      })
    );
    // Fall through to retry. If the retry also fails, return the safe default
    // so the worker can still apply deterministic parsing fallbacks.
  }

  if (result) {
    const costUsd = computeCostUsd(totalPromptTokens, totalCompletionTokens, model);

    // LLM10: Track usage in ai_usage table.
    if (tenantId) {
      await trackEmailUsage(tenantId, model, totalPromptTokens, totalCompletionTokens, costUsd, caseId);
    }

    return {
      ...result,
      extraction_model: model,
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      cost_usd: costUsd,
    };
  }

  // ── Attempt 2 (retry with stricter prompt) ───────────────────────────────
  const stricterSystem =
    systemPrompt +
    "\n\nIMPORTANT: Your previous response was invalid JSON. Return ONLY valid JSON matching the schema exactly. No markdown, no code blocks, no extra text.";

  try {
    const retryResponse = await client.chat.completions.create({
      model,
      response_format: OPENAI_JSON_SCHEMA,
      messages: [
        { role: "system", content: stricterSystem },
        { role: "user",   content: userMessage },
      ],
      temperature: 0,
      max_tokens: 2048,
    });

    const retryUsage = retryResponse.usage;
    const retryPromptTokens = retryUsage?.prompt_tokens ?? 0;
    const retryCompletionTokens = retryUsage?.completion_tokens ?? 0;
    totalPromptTokens += retryPromptTokens;
    totalCompletionTokens += retryCompletionTokens;

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "ai.email_extraction.attempt2",
        case_id: logCaseId,
        model,
        prompt_tokens: retryPromptTokens,
        completion_tokens: retryCompletionTokens,
      })
    );

    result = parseEmailResponse(retryResponse.choices[0]?.message?.content ?? null, model);
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    const apiErr = e as { status?: number; code?: string };
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "ai.email_extraction.attempt2.error",
        case_id: logCaseId,
        error_name: name,
        status: apiErr?.status ?? null,
        code: apiErr?.code ?? null,
      })
    );
  }

  if (result) {
    const costUsd = computeCostUsd(totalPromptTokens, totalCompletionTokens, model);
    if (tenantId) {
      await trackEmailUsage(tenantId, model, totalPromptTokens, totalCompletionTokens, costUsd, caseId);
    }
    return {
      ...result,
      extraction_model: model,
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      cost_usd: costUsd,
    };
  }

  // Both attempts failed — return safe default (LLM02 containment).
  // Do NOT throw — let the worker handle the safe default gracefully.
  console.warn(
    JSON.stringify({
      level: "warn",
      service: "claimmix",
      msg: "ai.email_extraction.both_attempts_failed.safe_default",
      case_id: logCaseId,
    })
  );
  return buildSafeDefault();
}

/**
 * Parse and validate email extractor output. Returns null on validation failure.
 * Exported for reuse by other providers (gemini-extractor).
 */
export function parseEmailResponse(content: string | null, model?: string): ExtractedClaim | null {
  if (!content) return null;
  try {
    const candidates = parseModelJsonCandidates(content);
    let issueCount = 0;
    for (const rawCandidate of candidates) {
      if (!looksLikeExtractionCandidate(rawCandidate)) continue;
      const parsed = ExtractedClaimSchema.safeParse(
        withEmailDefaults(rawCandidate, model)
      );
      if (parsed.success) return parsed.data;
      issueCount += parsed.error.issues.length;
    }

    if (candidates.length > 0) {
      console.error(
        "[openai-extractor] Email schema validation failed:",
        issueCount,
        "issues across",
        candidates.length,
        "JSON candidate(s)"
      );
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Safe default for parse failures — treats email as non-claim to avoid false positives.
 * Exported for reuse by other providers (gemini-extractor).
 */
export function buildSafeDefault(): ExtractedClaim {
  return {
    extraction_model: getModel(),
    fields: [],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    is_claim: false,
    confidence: 0,
    extracted_fields: undefined,
    field_confidences: {},
    missing_fields: [],
    fields_pending_confirmation: [],
    possible_customer_matches: [],
    possible_policy_matches: [],
    severity: null,
    requires_specialist: false,
    not_relevant_reason: "No se pudo procesar el email — error de extracción AI.",
    summary: "",
    suggested_reply: "",
    parse_failed: true,
  };
}

/** Track AI usage for the email extraction endpoint. */
async function trackEmailUsage(
  tenantId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  costUsd: number,
  caseId?: string
): Promise<void> {
  try {
    await recordUsage(
      tenantId,
      null, // system actor — no user context in webhook pipeline
      model,
      promptTokens,
      completionTokens,
      costUsd
    );
    void caseId; // tracked in audit log separately
  } catch {
    // recordUsage never throws, but defensive catch.
  }
}
