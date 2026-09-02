/**
 * Cómo se lee lo que contestó un modelo.
 *
 * Estaba adentro de `openai-extractor.ts` y no era de OpenAI: el extractor de
 * Gemini importaba de ahí el parseo, la validación y el tipo del payload de
 * email. Cuando OpenAI salió del producto, borrar ese archivo se llevaba
 * puesta la mitad del camino que sí se usa — así que primero se separó lo
 * neutral, que es esto.
 *
 * Nada de acá sabe qué proveedor contestó. Recibe un texto, saca de adentro el
 * JSON —un modelo lo envuelve en prosa, en un bloque markdown o en un objeto
 * de razonamiento antes de la respuesta final— y lo valida contra
 * `ExtractedClaimSchema` antes de que llegue a la base.
 *
 * AC17: nada que no haya pasado por el esquema se escribe.
 * LLM06: acá no se registra texto del reclamo, sólo conteos.
 */

import "server-only";
import { ExtractedClaimSchema } from "@/lib/schemas/extracted-claim";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { ClaimType } from "@/lib/schemas/cases";
import type { MemoryHint, KnownPattern, PromptLearningContext } from "./prompt";
import { getDefaultGeminiModel } from "./provider";

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
  if (!raw.extraction_model) raw.extraction_model = model ?? getDefaultGeminiModel();
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
      if (!raw.extraction_model) raw.extraction_model = model ?? getDefaultGeminiModel();
      const parsed = ExtractedClaimSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      issueCount += parsed.error.issues.length;
    }

    if (candidates.length > 0) {
      console.error(
        "[model-response] Schema validation failed:",
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


// ── El payload del extractor de email ────────────────────────────────────────

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
        "[model-response] Email schema validation failed:",
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
 *
 * Pass the tenant-resolved model when available; the env-var default is only a
 * last resort (it can differ from the tenant's configured model — e.g. env
 * OPENAI_MODEL=gpt-4o vs tenant gpt-4o-mini — which made failure logs lie).
 */
export function buildSafeDefault(model?: string): ExtractedClaim {
  return {
    extraction_model: model ?? getDefaultGeminiModel(),
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
    fraud_risk_level: "none",
    fraud_indicators: [],
    injury_severity: null,
    parse_failed: true,
  };
}
