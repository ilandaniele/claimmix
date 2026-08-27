/**
 * Two-layer severity classifier for insurance claims.
 *
 * Layer 1 (pattern): Scans the claim text against known_claim_patterns
 *   (seeded in migration 0008). Applies the highest matching severity.
 *
 * Layer 2 (AI): Uses the severity field returned by the LLM extractor.
 *
 * Final severity = MAX(pattern_layer, ai_layer).
 * The pattern layer can ESCALATE but not DEESCALATE the AI result.
 *
 * AC11: High/critical severity triggers specialist escalation.
 * AC15: Severity matrix — injuries+ambulance=high; death/fire/robbery=critical;
 *        minor damage=low; vehicle damage no injuries=medium.
 * AC25: Prompt injection in email body cannot affect the pattern layer —
 *        pattern matching is pure text scan, not LLM-controlled.
 *
 * Severity ranking: critical > high > medium > low
 */

import type { Severity } from "@/lib/schemas/cases";
import type { KnownPattern } from "./prompt";

/**
 * Check whether `text` (lowercase) contains `pattern` as a whole word or phrase.
 *
 * Uses word-boundary matching so "herido" does NOT match "sin heridos"
 * and "golpe leve" does NOT accidentally prevent "golpe" from matching.
 *
 * Rules:
 * - Multi-word phrases: plain substring match (the phrase boundary is already specific).
 * - Single keywords: require word boundary on both sides (\b equivalent via regex).
 *   Spanish accented chars are NOT word chars in JS \b, so we use a custom boundary
 *   check: char before and after the match must be a non-alphanumeric char (or start/end).
 */
function matchesPattern(text: string, pattern: string): boolean {
  const lower = pattern.toLowerCase();

  if (lower.includes(" ")) {
    // Multi-word phrase — substring match is specific enough.
    return text.includes(lower);
  }

  // Single keyword — use word boundary.
  // Build a regex with unicode-aware boundaries using \b equivalent:
  // Match if the keyword is preceded and followed by a non-word character.
  // We include Spanish accented letters as word characters.
  const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Regla detect-non-literal-regexp. `escaped` viene de la línea anterior,
  // que escapa los metacaracteres, y el patrón sale de una tabla fija del código,
  // no de nada que escriba un denunciante.
  // nosemgrep
  const re = new RegExp(
    `(?:^|[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9])${escaped}(?:[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9]|$)`,
    "i"
  );
  return re.test(text);
}

/** Numeric rank for severity comparison (higher = more severe). */
const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Return the higher-severity of two Severity values.
 */
function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Built-in keyword patterns for the pattern layer.
 * These are applied in addition to (not instead of) patterns from the DB.
 * Provides a baseline when the DB is not available.
 */
const BUILTIN_PATTERNS: ReadonlyArray<{ pattern: string; severity: Severity }> = [
  // ── CRITICAL ──────────────────────────────────────────────────────────────
  { pattern: "muerte",              severity: "critical" },
  { pattern: "fallecido",          severity: "critical" },
  { pattern: "fallecida",          severity: "critical" },
  { pattern: "fallecimiento",      severity: "critical" },
  { pattern: "muerto",             severity: "critical" },
  { pattern: "muerta",             severity: "critical" },
  { pattern: "incendio",           severity: "critical" },
  { pattern: "explosión",          severity: "critical" },
  { pattern: "explosion",          severity: "critical" },
  { pattern: "robo a mano armada", severity: "critical" },
  { pattern: "amenaza con arma",   severity: "critical" },
  { pattern: "amenaza",            severity: "critical" },

  // ── HIGH ──────────────────────────────────────────────────────────────────
  { pattern: "ambulancia",         severity: "high" },
  { pattern: "hospitalizado",      severity: "high" },
  { pattern: "hospitalizada",      severity: "high" },
  { pattern: "herido",             severity: "high" },
  { pattern: "herida",             severity: "high" },
  { pattern: "lesiones",           severity: "high" },
  { pattern: "lesionado",          severity: "high" },
  { pattern: "lesionada",          severity: "high" },
  { pattern: "policía",            severity: "high" },
  { pattern: "policia",            severity: "high" },
  { pattern: "urgencia",           severity: "high" },
  { pattern: "robo",               severity: "high" },
  { pattern: "hurto",              severity: "high" },

  // ── MEDIUM ────────────────────────────────────────────────────────────────
  { pattern: "choque",             severity: "medium" },
  { pattern: "colisión",           severity: "medium" },
  { pattern: "colision",           severity: "medium" },
  { pattern: "accidente",          severity: "medium" },
  { pattern: "granizo",            severity: "medium" },
  { pattern: "inundación",         severity: "medium" },
  { pattern: "inundacion",         severity: "medium" },
  { pattern: "chocaron",           severity: "medium" },

  // ── LOW ───────────────────────────────────────────────────────────────────
  { pattern: "rayones",            severity: "low" },
  { pattern: "rayón",              severity: "low" },
  { pattern: "golpe leve",         severity: "low" },
  { pattern: "daño menor",         severity: "low" },
  { pattern: "raspón",             severity: "low" },
  { pattern: "raspones",           severity: "low" },
  { pattern: "abolladura leve",    severity: "low" },
  { pattern: "daño estético",      severity: "low" },
  { pattern: "sin heridos",        severity: "low" },
];

/**
 * Run the pattern layer against the given text.
 *
 * Scans for each known pattern (case-insensitive substring match).
 * Longer phrases take priority when the same position is matched
 * (sorted by pattern length desc before scanning).
 *
 * Returns the HIGHEST severity found, or null if no pattern matched.
 *
 * @param text          - Full claim text to scan (email subject + body).
 * @param knownPatterns - Patterns from the known_claim_patterns DB table.
 */
function runPatternLayer(
  text: string,
  knownPatterns: KnownPattern[]
): Severity | null {
  const lower = text.toLowerCase();
  let highestSeverity: Severity | null = null;

  // Combine builtin patterns with DB patterns.
  // DB patterns override builtins where both match — we take max anyway.
  const allPatterns: Array<{ pattern: string; severity: Severity }> = [
    ...BUILTIN_PATTERNS,
    ...knownPatterns
      .filter((p) =>
        ["critical", "high", "medium", "low"].includes(p.severity_hint)
      )
      .map((p) => ({
        pattern: p.pattern_text.toLowerCase(),
        severity: p.severity_hint as Severity,
      })),
  ];

  // Sort by pattern length descending — match longer phrases first.
  // Longer phrases (e.g. "robo a mano armada") must be checked before their
  // shorter substrings (e.g. "robo") so the higher severity wins first.
  const sorted = [...allPatterns].sort(
    (a, b) => b.pattern.length - a.pattern.length
  );

  for (const { pattern, severity } of sorted) {
    if (matchesPattern(lower, pattern)) {
      if (highestSeverity === null) {
        highestSeverity = severity;
      } else {
        highestSeverity = maxSeverity(highestSeverity, severity);
      }
      // Short-circuit if already at critical — highest possible.
      if (highestSeverity === "critical") break;
    }
  }

  return highestSeverity;
}

/**
 * Classify severity using a two-layer approach:
 *   1. Pattern layer: scan text against known_claim_patterns.
 *   2. AI layer: use aiSeverity from LLM extractor output.
 *   Final: MAX(pattern, ai). Pattern can escalate but not deescalate.
 *
 * If both layers return null / undefined, defaults to "medium".
 *
 * @param text          - Claim text to scan (email subject + body concatenated).
 * @param aiSeverity    - Severity returned by the LLM extractor (may be null/undefined).
 * @param knownPatterns - Patterns from the known_claim_patterns table.
 * @returns             - Final Severity: "low" | "medium" | "high" | "critical"
 */
export function classifySeverity(
  text: string,
  aiSeverity: Severity | null | undefined,
  knownPatterns: KnownPattern[]
): Severity {
  const patternSeverity = runPatternLayer(text, knownPatterns);

  // Resolve AI severity (treat null/undefined as missing).
  const aiResolved: Severity | null = aiSeverity ?? null;

  if (patternSeverity !== null && aiResolved !== null) {
    // Both layers produced a result — take the higher one.
    return maxSeverity(patternSeverity, aiResolved);
  }

  if (patternSeverity !== null) {
    // Only pattern layer matched.
    return patternSeverity;
  }

  if (aiResolved !== null) {
    // Only AI layer provided a result.
    return aiResolved;
  }

  // No signal from either layer — default to medium for claim emails.
  return "medium";
}

/**
 * Returns true when the severity level requires specialist escalation (AC11).
 * high or critical → requires_specialist = true.
 */
export function requiresSpecialist(severity: Severity): boolean {
  return severity === "high" || severity === "critical";
}
