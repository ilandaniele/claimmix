/**
 * Google Gemini claim extractor — el único camino de extracción del producto.
 *
 * Uses the Generative Language REST API directly (no SDK dependency):
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * Defaults to gemini-2.5-flash (GEMINI_MODEL to override). El costo se estima
 * con el precio de lista: registrarlo en 0 fue correcto mientras corría por el
 * tier gratis de AI Studio, y dejó de serlo al pasar a Vertex postpago. Un tope
 * mensual en dólares contra una suma que siempre da cero no salta nunca.
 *
 * Postura de seguridad:
 * LLM01: prompts built by buildEmailClaimPrompt / buildSystemPrompt (XML sentinels).
 * LLM02: JSON output requested via Gemini structured output plus schema
 *        embedded in the prompt; output validated against ExtractedClaimSchema
 *        before any DB write (parseEmailResponse / parseResponse are shared
 *        histórico).
 * LLM06: Logs only case_id/tenant_id + token counts — never email bodies/PII.
 *        The API key travels in the x-goog-api-key header, never in the URL.
 *
 * Retry policy: one retry with a stricter prompt, then
 * safe default (email flow) or thrown error (simulate flow → case escalates).
 */

import "server-only";
import { tokenDeGcp } from "@/server/gcp/credenciales";
import { RESPUESTA_JSON_SCHEMA } from "@/lib/schemas/extracted-claim";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { ClaimType } from "@/lib/schemas/cases";
import { buildSystemPrompt, buildUserMessage, buildEmailClaimPrompt } from "./prompt";
import { computeCostUsd, recordUsage } from "./budget";
import { logProviderUsage } from "./provider-usage";
import {
  parseResponse,
  parseEmailResponse,
  buildSafeDefault,
} from "./model-response";
import type { EmailClaimPayload } from "./model-response";
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
    RESPUESTA_JSON_SCHEMA.json_schema.schema
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

/** Exponential backoff, shared by the HTTP and the network-error paths. */
function backoffMs(attempt: number): number {
  const baseMs = getNumberEnv(
    "GEMINI_RETRY_BASE_MS",
    DEFAULT_GEMINI_RETRY_BASE_MS,
    30_000
  );
  return Math.min(baseMs * 2 ** attempt, 30_000);
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

  return Math.min(backoffMs(attempt), capMs);
}

async function fetchGemini(url: string, init: RequestInit): Promise<Response> {
  const maxRetries = getNumberEnv(
    "GEMINI_MAX_RETRIES",
    DEFAULT_GEMINI_MAX_RETRIES,
    5
  );

  let lastNetworkError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await waitForGeminiSlot();

    // A connection that drops is as retryable as a 503, and until now it was
    // not retried at all: fetch throwing went straight up, the extraction
    // failed, and a claimant's message went unanswered because a socket
    // hiccuped. ECONNRESET and UND_ERR_CONNECT_TIMEOUT both showed up
    // repeatedly in a single afternoon of rehearsals.
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      lastNetworkError = err;
      if (attempt >= maxRetries) break;
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "claimmix",
          msg: "ai.transport_retry",
          attempt: attempt + 1,
          code: (err as { cause?: { code?: string } })?.cause?.code ?? "network",
        })
      );
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) return res;
    if (!isRetryableGeminiStatus(res.status) || attempt >= maxRetries) return res;
    await sleep(retryAfterMs(res.headers, attempt, res.status));
  }

  // Out of attempts on a connection that never opened. Thrown rather than
  // returned so the caller's own error handling sees it as the failure it is.
  throw new GeminiExtractionError(
    `No se pudo conectar con el modelo tras ${maxRetries + 1} intentos`,
    { code: (lastNetworkError as { cause?: { code?: string } })?.cause?.code }
  );
}

interface GeminiUsage {
  promptTokens: number;
  completionTokens: number;
}

// ── Transport: AI Studio (API key) vs Vertex AI (service account) ─────────────
//
// Same GenerateContent request/response shape on both — only the URL and auth
// differ, so the extractor logic below is transport-agnostic.
//
// Why Vertex matters: in some regions (e.g. Argentina) the AI Studio Gemini API
// is PREPAY-ONLY — no usable free tier, and calls 429 with "prepayment credits
// are depleted" until you top up. Vertex bills POSTPAY (ON_DEMAND) against the
// project's existing billing account, so there is no prepay wall. Vertex also
// still serves the pinned gemini-2.5-* models that AI Studio now 404s for
// newly-created keys.
//
// Enable with GEMINI_TRANSPORT=vertex (needs GOOGLE_CLOUD_PROJECT +
// GOOGLE_APPLICATION_CREDENTIALS, the same SA already used for fine-tuning).
function isVertexTransport(): boolean {
  return process.env.GEMINI_TRANSPORT?.trim().toLowerCase() === "vertex";
}

/**
 * Vertex model names differ from AI Studio's: there are no `*-latest` aliases
 * (they 404), and the pinned gemini-2.5-* names ARE available.
 *
 * Default is flash, NOT flash-lite. Lite is ~3x cheaper but cannot reliably
 * emit the full extraction schema for complex claims: measured 0/3 on
 * responsabilidad-civil scenarios (multiple parties, injuries, third-party
 * damage) versus 3/3 for flash, failing with invalid_json on both attempts so
 * the case escalates. RC claims are the high-value ones — losing them to save
 * ~$0.001 per extraction is a bad trade.
 */
function getVertexModel(): string {
  return process.env.VERTEX_EXTRACTION_MODEL?.trim() || "gemini-2.5-flash";
}

async function getVertexToken(): Promise<string> {
  try {
    return await tokenDeGcp();
  } catch (err) {
    throw new GeminiExtractionError(`Vertex: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Single generateContent call. Returns the raw text + token usage.
 * Throws on HTTP/network errors (caller handles retry).
 *
 * Exported so other callers reuse the transport rules rather than rebuilding
 * them: Vertex vs AI Studio endpoints, the two auth shapes, and thinking
 * disabled. That last one is not a preference — a thinking-enabled default
 * once burned $0.78 a call and drained a $10 prepay in sixteen of them.
 */
export interface InlineMedia {
  mimeType: string;
  /** Base64 bytes, no data: prefix. */
  data: string;
}

export async function callGemini(
  systemPrompt: string,
  userMessage: string,
  apiKey?: string | null,
  modelOverride?: string,
  /** Images or documents to look at alongside the text. */
  media?: InlineMedia[]
): Promise<{ text: string | null; usage: GeminiUsage }> {
  const vertex = isVertexTransport();
  // Vertex has its own model catalog (no *-latest aliases) — never forward the
  // AI-Studio-flavoured model name to it, it would 404.
  const model = vertex ? getVertexModel() : (modelOverride ?? getGeminiModel());

  let endpoint: string;
  let authHeaders: Record<string, string>;

  if (vertex) {
    const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
    const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || "us-central1";
    if (!project) {
      throw new GeminiExtractionError(
        "GEMINI_TRANSPORT=vertex requires GOOGLE_CLOUD_PROJECT to be set."
      );
    }
    endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
    authHeaders = { Authorization: `Bearer ${await getVertexToken()}` };
  } else {
    const key = apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) {
      throw new GeminiExtractionError(
        "GEMINI_API_KEY is not set. Configure it in Configuración."
      );
    }
    endpoint = `${GEMINI_API_BASE}/${model}:generateContent`;
    authHeaders = { "x-goog-api-key": key };
  }

  // Modern Gemini models (2.5+, 3.x, and the *-latest aliases) THINK by default.
  // Thinking tokens are billed (often 10-50× the visible output) and add latency
  // — pure waste for deterministic JSON extraction. Disable it for every
  // thinking-capable model, not just gemini-2.5* (a gemini-flash-latest default
  // with thinking ON burned ~$0.78/call and drained a $10 prepay in 16 calls).
  // Legacy non-thinking models (gemini-2.0*, deprecated) are the only exception.
  const isThinkingModel = !model.startsWith("gemini-2.0");
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: userMessage },
          ...(media ?? []).map((m) => ({
            inlineData: { mimeType: m.mimeType, data: m.data },
          })),
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      ...(isThinkingModel ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };

  const res = await fetchGemini(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
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
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  /*
   * Una respuesta cortada por el tope no es una respuesta.
   *
   * Gemini avisa con `finishReason: "MAX_TOKENS"` cuando se queda sin lugar, y
   * hasta acá nadie lo leía: el HTTP era 200, se devolvía el texto parcial, y
   * aguas abajo se parseaba lo que hubiera llegado. Los campos que faltaban
   * faltaban en silencio.
   *
   * Pasa en el 2% de las extracciones de producción —71 de 3.627— y el promedio
   * de salida es 1.497 tokens, así que las que llegan a 8.192 no son respuestas
   * largas: son respuestas que se fueron de largo.
   *
   * Lo que se veía en su lugar era el sistema pidiéndole al asegurado algo que
   * acababa de decir. En el ensayo: «¡Gracias, Roberto! Necesitamos que nos
   * envíes: • Tu nombre y apellido completo.» El modelo leyó el nombre —lo usa
   * en el saludo— pero el JSON se cortó antes de guardarlo, así que el análisis
   * de faltantes lo seguía contando como faltante.
   *
   * Tirar acá lo manda al segundo intento, que corre con un prompt más estricto
   * — que es justo lo que hay que hacer con un modelo que se fue por las ramas.
   * Un fallo técnico se levanta como fallo técnico y no se convierte en un dato
   * que falta.
   */
  const finishReason = data.candidates?.[0]?.finishReason;
  if (finishReason === "MAX_TOKENS") {
    throw new GeminiExtractionError(
      "Gemini cortó la respuesta en el tope de tokens (finishReason=MAX_TOKENS)",
      { status: 200, code: "MAX_TOKENS" }
    );
  }

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
 * El extractor de emails entrantes — mismo payload, misma validación,
 * same safe-default containment. cost_usd is always 0 (free tier).
 */
export async function extractEmailClaimGemini(
  payload: EmailClaimPayload,
  tenantId?: string,
  caseId?: string,
  userId?: string | null
): Promise<ExtractedClaim> {
  // Transport-aware: on Vertex the tenant/AI-Studio model name is not used
  // (different catalog), so resolve the real one here — otherwise logs and
  // agent_runs would record a model that was never actually called.
  const model = isVertexTransport()
    ? getVertexModel()
    : await getTenantGeminiModel(tenantId);
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
    // LLM10: track usage so the token caps and the monthly USD cap both apply.
    //
    // Registraba 0 con el comentario "free tier", cierto mientras corría por
    // AI Studio. Con Vertex postpago dejó de serlo y nadie lo notó: un tope en
    // dólares contra una suma que siempre da cero no salta nunca.
    const costUsd = computeCostUsd(totalPromptTokens, totalCompletionTokens, model);
    if (tenantId) {
      try {
        /*
         * `userId` y no `null`.
         *
         * Estaba en `null` teniéndolo a mano —llega en la firma de esta
         * función— así que NINGUNA fila de `ai_usage` tenía usuario: 7.554 de
         * 7.554 en cero. El cupo diario por usuario suma sobre un conjunto
         * vacío, da 0, y deja pasar siempre. Un tope que no puede alcanzarse
         * nunca.
         */
        await recordUsage(tenantId, userId ?? null, model, totalPromptTokens, totalCompletionTokens, costUsd);
      } catch {
        // recordUsage never throws, but defensive catch.
      }
    }

    return {
      ...result,
      extraction_model: model,
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      cost_usd: costUsd,
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
 * El extractor del camino de simulación.
 * Throws GeminiExtractionError after two failed attempts (worker escalates).
 */
export async function runGeminiExtractor(
  rawText: string,
  claimType: ClaimType,
  caseId: string,
  tenantId?: string,
  userId?: string | null
): Promise<ExtractedClaim> {
  // Transport-aware: on Vertex the tenant/AI-Studio model name is not used
  // (different catalog), so resolve the real one here — otherwise logs and
  // agent_runs would record a model that was never actually called.
  const model = isVertexTransport()
    ? getVertexModel()
    : await getTenantGeminiModel(tenantId);
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
      cost_usd: computeCostUsd(totalPromptTokens, totalCompletionTokens, model),
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
