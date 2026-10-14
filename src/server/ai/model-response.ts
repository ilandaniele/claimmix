// Parse and validate a model's JSON answer. Provider-agnostic.

import "server-only";
import { ExtractedClaimSchema } from "@/lib/schemas/extracted-claim";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { MemoryHint, KnownPattern, PromptLearningContext } from "./prompt";
import { getDefaultGeminiModel } from "./provider";
import { logger } from "@/lib/observability/logger";

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
  /** email | email_sim | whatsapp | whatsapp_sim — cambia el consejo sobre el remitente. */
  channel?: string;
  /**
   * Fotos y PDFs del caso que el modelo todavía no miró, en base64. Van en la
   * misma llamada: leerlos aparte sería otra llamada por turno.
   */
  media?: { mimeType: string; data: string }[];
  /**
   * Una extracción anterior de este caso falló por algo pasajero (plazo, 429 o red: intentos_de_extraccion > 0).
   * El contador no se reinicia, así que vale para toda extracción posterior del caso: va concisa y a 0,3.
   */
  trasCorte?: boolean;
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
      logger.error({ issues: issueCount, candidatos: candidates.length }, "model_response.email_schema_validation_failed");
    }
    return null;
  } catch {
    return null;
  }
}
