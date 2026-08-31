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
 * Matches singular AND plural, and skips occurrences that a negation turns
 * into their own absence ("sin heridos", "no hubo heridos", "ningún herido").
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

  const escaped = lower.replace(/[.*+?^${}()|[\\\\]]/g, "\\$&");

  /*
   * El plural cuenta igual que el singular.
   *
   * Antes no: la frontera de palabra hacía que «herido» NO matcheara «heridos»,
   * y eso estaba escrito como una virtud —«así "herido" no matchea "sin
   * heridos"»—. El costo estaba del otro lado y nadie lo había medido:
   *
   *   «Hay un herido.»                 → high     → especialista
   *   «Hay tres heridos.»              → medium   → nadie
   *   «Hubo un muerto.»                → critical → especialista
   *   «Hubo dos muertos.»              → medium   → nadie
   *
   * O sea que el caso MÁS grave era el que se escapaba, y por una regla puesta
   * para evitar un falso positivo que ahora se resuelve mirando la negación.
   *
   * La capa de patrones es la red: cuando el modelo acierta, escala igual. Esto
   * es para cuando el modelo no está o se equivoca, que es exactamente cuando
   * una red tiene que estar entera.
   */
  // Regla detect-non-literal-regexp. `escaped` viene de la línea anterior,
  // que escapa los metacaracteres, y el patrón sale de una tabla fija del código,
  // no de nada que escriba un denunciante.
  // nosemgrep
  const re = new RegExp(
    `(?:^|[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9])(${escaped}(?:es|s)?)(?:[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9]|$)`,
    "gi"
  );

  /*
   * Y una aparición NEGADA no cuenta.
   *
   * Con el plural adentro, «sin heridos» pasaría a disparar «herido» y de ahí a
   * `high`, porque la capa se queda con el máximo y el `sin heridos → low` de
   * la tabla nunca gana. Antes eso lo evitaba el accidente de la frontera de
   * palabra; ahora lo evita mirar lo que hay adelante, que es lo que la frase
   * quiere decir.
   *
   * Se permite UNA palabra entre el negador y la palabra —«sin ningún herido»—
   * y no más: con dos, «sin duda hay heridos» quedaría negado, y ahí sí hay
   * heridos.
   */
  let alguna = false;
  for (const m of text.matchAll(re)) {
    // Dónde arranca la palabra: `m[0]` trae adelante el carácter de frontera.
    const inicio = m.index + m[0].indexOf(m[1]);
    // Los treinta caracteres de ANTES. La primera versión de esto cortaba
    // desde `m.index`, o sea que miraba un único carácter —la frontera— y
    // la negación no se veía nunca.
    const antes = text.slice(Math.max(0, inicio - 30), inicio);
    if (NEGADORES.test(antes)) continue;
    alguna = true;
    break;
  }
  return alguna;
}

/**
 * Lo que convierte una palabra grave en su ausencia.
 *
 * «sin heridos», «no hubo heridos», «ningún herido», «sin heridos ni
 * lesionados» — el `ni` arrastra la negación en castellano. Se mira sólo lo
 * que está
 * pegado adelante de la palabra, no toda la frase: «hay heridos, sin duda» no
 * es una negación de «heridos».
 *
 * Una palabra intermedia como mucho. Con dos, «sin duda hay heridos» quedaría
 * negado — y ahí sí hay heridos. Por lo mismo «ni bien llegó la ambulancia»
 * (tres palabras de por medio) no niega la ambulancia, y «ni la ambulancia
 * vino» (una) sí, que es lo que esa frase dice.
 */
const NEGADORES =
  /(?:^|[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9])(?:sin|no hubo|no hay|no hab[ií]a|ning[uú]n|ninguna|ni)(?:[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9]+[a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9]+)?[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9]*$/i;

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
