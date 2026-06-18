/**
 * Google Gemini claim extractor — drop-in alternative to the OpenAI extractor.
 *
 * Uses the Generative Language REST API directly (no SDK dependency):
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * Free tier friendly: defaults to gemini-2.5-flash (GEMINI_MODEL to override)
 * and records cost_usd = 0 (the free tier is not billed).
 *
 * Same security posture as the OpenAI extractor:
 * LLM01: prompts built by buildEmailClaimPrompt / buildSystemPrompt (XML sentinels).
 * LLM02: JSON output requested via responseMimeType + schema embedded in the
 *        prompt; output validated against ExtractedClaimSchema before any DB
 *        write (parseEmailResponse / parseResponse are shared with OpenAI).
 * LLM06: Logs only case_id/tenant_id + token counts — never email bodies/PII.
 *        The API key travels in the x-goog-api-key header, never in the URL.
 *
 * Retry policy mirrors OpenAI: one retry with a stricter prompt, then
 * safe default (email flow) or thrown error (simulate flow → case escalates).
 */

import "server-only";
import { OPENAI_JSON_SCHEMA } from "@/lib/schemas/extracted-claim";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { ClaimType } from "@/lib/schemas/cases";
import { buildSystemPrompt, buildUserMessage, buildEmailClaimPrompt } from "./prompt";
import { recordUsage } from "./budget";
import {
  parseResponse,
  parseEmailResponse,
  buildSafeDefault,
} from "./openai-extractor";
import type { EmailClaimPayload } from "./openai-extractor";
import { getDefaultGeminiModel, getTenantGeminiKey, getTenantGeminiModel } from "./provider";

/** Custom error for unrecoverable Gemini extraction failures (simulate flow). */
export class GeminiExtractionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "GeminiExtractionError";
  }
}

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

/** Returns the configured Gemini model. Override with GEMINI_MODEL env var. */
export function getGeminiModel(): string {
  return getDefaultGeminiModel();
}

/** Compact schema block appended to the system prompt — Gemini has no
 *  strict-schema response_format equivalent we can rely on across models,
 *  so the exact output shape is stated in the prompt and validated with Zod. */
function schemaSuffix(): string {
  return `\n\nOUTPUT JSON SCHEMA — return ONE JSON object matching this schema exactly (no markdown, no code fences, no extra text):\n${JSON.stringify(
    OPENAI_JSON_SCHEMA.json_schema.schema
  )}`;
}

interface GeminiUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Single generateContent call. Returns the raw text + token usage.
 * Throws on HTTP/network errors (caller handles retry).
 */
async function callGemini(
  systemPrompt: string,
  userMessage: string,
  apiKey?: string | null,
  modelOverride?: string
): Promise<{ text: string | null; usage: GeminiUsage }> {
  const key = apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) {
    throw new GeminiExtractionError(
      "GEMINI_API_KEY is not set. Configure it in Configuración or switch the tenant provider to OpenAI."
    );
  }

  const model = modelOverride ?? getGeminiModel();

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      // 2.5-series models think by default; thinking tokens count against
      // maxOutputTokens and add latency — disable for deterministic extraction.
      ...(model.startsWith("gemini-2.5")
        ? { thinkingConfig: { thinkingBudget: 0 } }
        : {}),
    },
  };

  const res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      error?: { status?: string; message?: string };
    } | null;
    throw new GeminiExtractionError(
      `Gemini API error ${res.status} ${errBody?.error?.status ?? ""}`.trim(),
      { status: res.status, code: errBody?.error?.status }
    );
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? null;

  return {
    text: text && text.trim() ? text : null,
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

/** Extract status/code from a thrown error for structured logging. */
function errMeta(e: unknown): { name: string; status: number | null; code: string | null } {
  const name = e instanceof Error ? e.name : "UnknownError";
  const cause = (e as GeminiExtractionError)?.cause as
    | { status?: number; code?: string }
    | undefined;
  return {
    name,
    status: cause?.status ?? null,
    code: cause?.code ?? null,
  };
}

// ── Email claim extractor (primary production path) ───────────────────────────

/**
 * Gemini counterpart of extractEmailClaim() — same payload, same validation,
 * same safe-default containment. cost_usd is always 0 (free tier).
 */
export async function extractEmailClaimGemini(
  payload: EmailClaimPayload,
  tenantId?: string,
  caseId?: string,
  userId?: string | null
): Promise<ExtractedClaim> {
  const model = await getTenantGeminiModel(tenantId);
  const logCaseId = caseId ?? "unknown";
  const logTenantId = tenantId ?? "unknown";
  const tenantKey = tenantId ? await getTenantGeminiKey(tenantId, userId ?? undefined) : null;

  const systemPrompt =
    buildEmailClaimPrompt(
      payload.subject,
      payload.body,
      payload.memoryHints,
      payload.knownPatterns,
      payload.senderEmail,
      payload.agentTraining,
      payload.learning
    ) + schemaSuffix();

  const userMessage =
    "Analyze the email provided in the system prompt and return the structured JSON extraction.";

  let result: ExtractedClaim | null = null;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  // ── Attempt 1 ─────────────────────────────────────────────────────────────
  try {
    const { text, usage } = await callGemini(systemPrompt, userMessage, tenantKey, model);
    totalPromptTokens = usage.promptTokens;
    totalCompletionTokens = usage.completionTokens;

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "ai.email_extraction.attempt1",
        provider: "gemini",
        case_id: logCaseId,
        tenant_id: logTenantId,
        model,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
      })
    );

    result = parseEmailResponse(text, model);
  } catch (e) {
    const meta = errMeta(e);
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "ai.email_extraction.attempt1.error",
        provider: "gemini",
        case_id: logCaseId,
        error_name: meta.name,
        status: meta.status,
        code: meta.code,
      })
    );
  }

  // ── Attempt 2 (retry with stricter prompt) ───────────────────────────────
  if (!result) {
    const stricterSystem =
      systemPrompt +
      "\n\nIMPORTANT: Your previous response was invalid JSON. Return ONLY valid JSON matching the schema exactly. No markdown, no code blocks, no extra text.";

    try {
      const { text, usage } = await callGemini(stricterSystem, userMessage, tenantKey, model);
      totalPromptTokens += usage.promptTokens;
      totalCompletionTokens += usage.completionTokens;

      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: "ai.email_extraction.attempt2",
          provider: "gemini",
          case_id: logCaseId,
          model,
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
        })
      );

      result = parseEmailResponse(text, model);
    } catch (e) {
      const meta = errMeta(e);
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: "ai.email_extraction.attempt2.error",
          provider: "gemini",
          case_id: logCaseId,
          error_name: meta.name,
          status: meta.status,
          code: meta.code,
        })
      );
    }
  }

  if (result) {
    // LLM10: track usage (cost 0 — free tier) so token caps still apply.
    if (tenantId) {
      try {
        await recordUsage(tenantId, null, model, totalPromptTokens, totalCompletionTokens, 0);
      } catch {
        // recordUsage never throws, but defensive catch.
      }
    }

    return {
      ...result,
      extraction_model: model,
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      cost_usd: 0,
    };
  }

  // Both attempts failed — safe default (LLM02 containment), same as OpenAI path.
  console.warn(
    JSON.stringify({
      level: "warn",
      service: "claimmix",
      msg: "ai.email_extraction.both_attempts_failed.safe_default",
      provider: "gemini",
      case_id: logCaseId,
    })
  );
  return { ...buildSafeDefault(), extraction_model: model };
}

// ── Simulate-flow extractor ────────────────────────────────────────────────────

/**
 * Gemini counterpart of runOpenAIExtractor() — used by the simulate pipeline.
 * Throws GeminiExtractionError after two failed attempts (worker escalates).
 */
export async function runGeminiExtractor(
  rawText: string,
  claimType: ClaimType,
  caseId: string,
  tenantId?: string,
  userId?: string | null
): Promise<ExtractedClaim> {
  const model = await getTenantGeminiModel(tenantId);
  const tenantKey = tenantId ? await getTenantGeminiKey(tenantId, userId ?? undefined) : null;
  const systemPrompt = buildSystemPrompt(claimType) + schemaSuffix();
  const userMessage = buildUserMessage(rawText);

  let result: ExtractedClaim | null = null;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    const prompt =
      attempt === 1
        ? systemPrompt
        : systemPrompt +
          "\n\nIMPORTANT: Your previous response was invalid JSON. Return ONLY valid JSON matching the schema exactly. No markdown, no code blocks, no extra text.";

    try {
      const { text, usage } = await callGemini(prompt, userMessage, tenantKey, model);
      totalPromptTokens += usage.promptTokens;
      totalCompletionTokens += usage.completionTokens;

      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: `ai.extraction.attempt${attempt}`,
          provider: "gemini",
          case_id: caseId,
          model,
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
        })
      );

      result = parseResponse(text, claimType, model);
    } catch (e) {
      const meta = errMeta(e);
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: `ai.extraction.attempt${attempt}.error`,
          provider: "gemini",
          case_id: caseId,
          error_name: meta.name,
          status: meta.status,
          code: meta.code,
        })
      );
    }
  }

  if (result) {
    return {
      ...result,
      extraction_model: model,
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      cost_usd: 0,
    };
  }

  throw new GeminiExtractionError(
    `AI extraction failed after 2 attempts for case ${caseId}`
  );
}
