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
 * LLM02: JSON output requested via Gemini structured output plus schema
 *        embedded in the prompt; output validated against ExtractedClaimSchema
 *        before any DB write (parseEmailResponse / parseResponse are shared
 *        with OpenAI).
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
import { logProviderUsage } from "./provider-usage";
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

const DEFAULT_GEMINI_MIN_REQUEST_INTERVAL_MS =
  process.env.NODE_ENV === "test" ? 0 : 1_200;
const DEFAULT_GEMINI_RETRY_BASE_MS =
  process.env.NODE_ENV === "test" ? 0 : 1_000;
const DEFAULT_GEMINI_MAX_RETRIES = 3;

let geminiRequestQueue: Promise<void> = Promise.resolve();
let lastGeminiRequestAt = 0;

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

function getNumberEnv(name: string, fallback: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGeminiSlot(): Promise<void> {
  const minIntervalMs = getNumberEnv(
    "GEMINI_MIN_REQUEST_INTERVAL_MS",
    DEFAULT_GEMINI_MIN_REQUEST_INTERVAL_MS,
    60_000
  );
  if (minIntervalMs <= 0) return;

  const run = geminiRequestQueue.then(async () => {
    const elapsed = Date.now() - lastGeminiRequestAt;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    lastGeminiRequestAt = Date.now();
  });
  geminiRequestQueue = run.catch(() => undefined);
  await run;
}

function isRetryableGeminiStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryAfterMs(headers: Headers, attempt: number, status: number): number {
  // Cap 429 retries at 10s so the Vercel after() worker (maxDuration=180s) has
  // time to run the GeminiExtractionError catch + escalate the case.
  // Daily quota exhaustion (RESOURCE_EXHAUSTED) won't recover in minutes anyway —
  // failing fast lets the case escalate so a human can re-trigger it.
  const capMs = status === 429 ? 10_000 : 30_000;
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, capMs);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.min(Math.max(dateMs - Date.now(), 0), capMs);
  }

  const baseMs = getNumberEnv(
    "GEMINI_RETRY_BASE_MS",
    DEFAULT_GEMINI_RETRY_BASE_MS,
    30_000
  );
  return Math.min(baseMs * 2 ** attempt, capMs);
}

async function fetchGemini(url: string, init: RequestInit): Promise<Response> {
  const maxRetries = getNumberEnv(
    "GEMINI_MAX_RETRIES",
    DEFAULT_GEMINI_MAX_RETRIES,
    5
  );

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await waitForGeminiSlot();
    const res = await fetch(url, init);
    if (res.ok) return res;
    if (!isRetryableGeminiStatus(res.status) || attempt >= maxRetries) return res;
    await sleep(retryAfterMs(res.headers, attempt, res.status));
  }

  return fetch(url, init);
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

  const res = await fetchGemini(`${GEMINI_API_BASE}/${model}:generateContent`, {
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
  // Last attempt's error status/code — propagated on the final throw so the
  // worker can persist the real cause (429/RESOURCE_EXHAUSTED, 401, ...).
  let lastErrMeta: { name: string; status: number | null; code: string | null } | null = null;

  // ── Attempt 1 ─────────────────────────────────────────────────────────────
  const t1 = Date.now();
  try {
    const { text, usage } = await callGemini(systemPrompt, userMessage, tenantKey, model);
    const latency1 = Date.now() - t1;
    totalPromptTokens = usage.promptTokens;
    totalCompletionTokens = usage.completionTokens;

    result = parseEmailResponse(text, model);

    const status1 = result ? "success" : "invalid_json";
    if (tenantId) {
      await logProviderUsage({
        tenantId, provider: "gemini", model, operation: "email_extraction",
        status: status1, latencyMs: latency1,
        promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      });
    }

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "ai.email_extraction.attempt1",
        provider: "gemini",
        case_id: logCaseId,
        tenant_id: logTenantId,
        model,
        status: status1,
        latency_ms: latency1,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
      })
    );
  } catch (e) {
    const latency1 = Date.now() - t1;
    const meta = errMeta(e);
    lastErrMeta = meta;
    const errStatus = meta.status === 429 ? "rate_limited" : "error";
    if (tenantId) {
      await logProviderUsage({
        tenantId, provider: "gemini", model, operation: "email_extraction",
        status: errStatus, latencyMs: latency1,
        errorCode: String(meta.status ?? meta.code ?? "error"),
        errorMessage: e instanceof Error ? e.message.slice(0, 500) : undefined,
      });
    }
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

    const t2 = Date.now();
    try {
      const { text, usage } = await callGemini(stricterSystem, userMessage, tenantKey, model);
      const latency2 = Date.now() - t2;
      totalPromptTokens += usage.promptTokens;
      totalCompletionTokens += usage.completionTokens;

      result = parseEmailResponse(text, model);

      const status2 = result ? "success" : "invalid_json";
      if (tenantId) {
        await logProviderUsage({
          tenantId, provider: "gemini", model, operation: "email_extraction",
          status: status2, latencyMs: latency2,
          promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
          retryCount: 1,
        });
      }

      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: "ai.email_extraction.attempt2",
          provider: "gemini",
          case_id: logCaseId,
          model,
          status: status2,
          latency_ms: latency2,
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
        })
      );
    } catch (e) {
      const latency2 = Date.now() - t2;
      const meta = errMeta(e);
      lastErrMeta = meta;
      const errStatus2 = meta.status === 429 ? "rate_limited" : "error";
      if (tenantId) {
        await logProviderUsage({
          tenantId, provider: "gemini", model, operation: "email_extraction",
          status: errStatus2, latencyMs: latency2,
          errorCode: String(meta.status ?? meta.code ?? "error"),
          errorMessage: e instanceof Error ? e.message.slice(0, 500) : undefined,
          retryCount: 1,
        });
      }
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

  // Both attempts failed — throw instead of returning is_claim:false safe default.
  // Returning buildSafeDefault() (is_claim:false) would incorrectly mark cases as
  // no_relevante due to a provider/network/quota error, not a genuine classification.
  // The caller (runEmailExtractionWorker) catches GeminiExtractionError and sets
  // the case to 'escalado' so it can be re-analyzed once the provider recovers.
  console.error(
    JSON.stringify({
      level: "error",
      service: "claimmix",
      msg: "ai.email_extraction.both_attempts_failed.provider_error",
      provider: "gemini",
      case_id: logCaseId,
      status: lastErrMeta?.status ?? null,
      code: lastErrMeta?.code ?? null,
    })
  );
  throw new GeminiExtractionError(
    `Gemini extraction technical failure after 2 attempts for case ${logCaseId}`,
    {
      provider_error: true,
      case_id: logCaseId,
      status: lastErrMeta?.status ?? undefined,
      code: lastErrMeta?.code ?? undefined,
    }
  );
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
  let lastErrMeta: { name: string; status: number | null; code: string | null } | null = null;

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
      lastErrMeta = meta;
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
    `AI extraction failed after 2 attempts for case ${caseId}`,
    {
      provider_error: true,
      case_id: caseId,
      status: lastErrMeta?.status ?? undefined,
      code: lastErrMeta?.code ?? undefined,
    }
  );
}
