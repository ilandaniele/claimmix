/**
 * Trainability assessment for agent runs.
 *
 * Every processed email gets a SUGGESTION of whether it is a good training
 * candidate. This is only a suggestion — the agent NEVER learns from an email
 * until a human clicks "Confirmar como ejemplo de entrenamiento seguro".
 * Emails are untrusted until reviewed.
 *
 * Blocking reasons (suggestion forced to false, and approval API refuses
 * the unsafe ones even with human override):
 *   - invalid_json:               extractor fell back to the safe default
 *   - not_a_claim:                is_claim !== true (spam / irrelevant)
 *   - no_linked_case:             run is not linked to a valid case
 *   - prompt_injection_suspected: email contains instruction-like attack text
 *   - unresolved_conflicts:       fields are pending analyst confirmation
 *
 * LLM06: this module never logs email content — callers log only reasons.
 */

import "server-only";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";

export interface TrainabilityAssessment {
  isTrainableSuggestion: boolean;
  /** 0.000–1.000, rounded to 3 decimals. */
  trainabilityScore: number;
  trainabilityReasons: string[];
  blockingReasons: string[];
}

/**
 * Blocking reasons that can NEVER be overridden by a human approval —
 * a poisoned or unparseable example must not enter the training set.
 */
export const UNSAFE_BLOCKING_REASONS = new Set([
  "invalid_json",
  "prompt_injection_suspected",
]);

/** Suggestion threshold: score must reach this AND have no blocking reasons. */
const SUGGESTION_THRESHOLD = 0.7;

/** Confidence at which a field counts as a strong supervised signal. */
const HIGH_CONFIDENCE = 0.85;

/**
 * Instruction-like patterns (Spanish + English) that indicate a prompt
 * injection attempt. Conservative on purpose: false negatives are caught by
 * the human review step; false positives only suppress a suggestion.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignor(?:e|a|á)\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions?/i,
  // Spanish order: "ignorá (todas) las instrucciones (anteriores/previas)"
  /ignor(?:e|a|á)\s+(?:tod(?:as|o)s?\s+)?(?:las?\s+)?instrucciones/i,
  /disregard\s+(?:the\s+)?(?:previous|prior|above|system)/i,
  /(?:reveal|show|print|ignore)\s+(?:your\s+)?system\s+prompt/i,
  /system\s+prompt/i,
  /act\s+as\s+(?:a|an)\s+different/i,
  /actu(?:á|a)\s+como\s+(?:otro|otra|un[oa]?\s+diferente)/i,
  /jailbreak/i,
  /\bDAN\s+mode\b/i,
  /set\s+(?:is_claim|severity|status|confidence)\s*=/i,
  // Embedded copies of our own sentinel tags are a strong injection signal.
  /<\/?(?:email_body|email_subject|agent_training|agent_rules|memory_hints|severity_patterns|approved_examples|claim_text)>/i,
];

/** Returns the list of matched injection signals (empty = clean). */
export function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export interface TrainabilityInput {
  /** Validated extractor output (post-hydration). */
  claim: ExtractedClaim;
  /** True when the extractor returned the safe default after JSON failures. */
  parseFailed: boolean;
  /** The case this run is linked to (null/undefined = unlinked). */
  caseId: string | null | undefined;
  /** Raw subject + body — scanned for injection patterns, never logged. */
  emailText: string;
}

/**
 * Compute the trainability suggestion for one agent run.
 * Pure function — no I/O, fully unit-testable.
 */
export function assessTrainability(input: TrainabilityInput): TrainabilityAssessment {
  const { claim, parseFailed, caseId, emailText } = input;

  const reasons: string[] = [];
  const blocking: string[] = [];

  // ── Hard gates ──────────────────────────────────────────────────────────────
  if (parseFailed) {
    blocking.push("invalid_json");
  } else {
    reasons.push("valid_json");
  }

  if (claim.is_claim !== true) {
    blocking.push("not_a_claim");
  } else {
    reasons.push("claim_detected");
  }

  if (!caseId) {
    blocking.push("no_linked_case");
  } else {
    reasons.push("linked_to_case");
  }

  if (detectPromptInjection(emailText)) {
    blocking.push("prompt_injection_suspected");
  }

  const pendingCount = (claim.fields_pending_confirmation ?? []).length;
  if (pendingCount > 0) {
    blocking.push("unresolved_conflicts");
  } else {
    reasons.push("no_pending_confirmations");
  }

  // ── Score components ────────────────────────────────────────────────────────
  const fields = claim.fields ?? [];
  const confidences = fields
    .map((f) => f.confidence)
    .filter((c): c is number => typeof c === "number");

  const avgConfidence =
    confidences.length > 0
      ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
      : 0;

  const highConfidenceCount = confidences.filter((c) => c >= HIGH_CONFIDENCE).length;
  const missingCount = (claim.missing_fields ?? []).length;

  if (highConfidenceCount >= 3) {
    reasons.push(`high_confidence_fields:${highConfidenceCount}`);
  }
  if (missingCount === 0 && fields.length > 0) {
    reasons.push("no_missing_fields");
  }

  // Weighted score: field confidence dominates; completeness and cleanliness
  // round it out. Blocking reasons cap the score so the UI bar reads "low".
  let score =
    avgConfidence * 0.5 +
    Math.min(highConfidenceCount, 4) * 0.05 +
    (missingCount === 0 ? 0.15 : Math.max(0, 0.15 - missingCount * 0.04)) +
    (pendingCount === 0 ? 0.15 : 0);

  if (blocking.length > 0) {
    score = Math.min(score, 0.25);
  }

  score = Math.max(0, Math.min(1, score));
  const rounded = Math.round(score * 1000) / 1000;

  return {
    isTrainableSuggestion: blocking.length === 0 && rounded >= SUGGESTION_THRESHOLD,
    trainabilityScore: rounded,
    trainabilityReasons: reasons,
    blockingReasons: blocking,
  };
}
