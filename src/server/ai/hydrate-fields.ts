/**
 * Defensive helpers for AI extraction output.
 *
 * T02: hydrateFieldsFromExtracted — mirrors every typed extracted_fields key
 *      into the fields[] array if it is not already there.
 *
 * T03: scrubPiiFromSummary — removes PII tokens from the free-text summary,
 *      suggested_reply, and not_relevant_reason fields before they are
 *      persisted or rendered in outbound templates.
 *
 * Both functions are pure (no side effects, no DB access) and fully testable.
 *
 * LLM06: These helpers are a defensive layer — the primary fix is in the prompt
 *        (RULE D / RULE F). They ensure correctness even if the model regresses.
 */

import "server-only";
import type { ExtractedClaim, ExtractedField, ClaimFields } from "@/lib/schemas/extracted-claim";

/**
 * The set of ClaimFields keys that hydration mirrors into fields[].
 * Must stay in sync with ClaimFieldsSchema.
 */
const HYDRATED_KEYS = [
  "full_name",
  "email",
  "phone",
  "dni",
  "policy_number",
  "accident_date",
  "accident_location",
  "accident_description",
  "claim_type",
] as const;

type HydratedKey = (typeof HYDRATED_KEYS)[number];

/**
 * Ensure every populated key in extracted_fields also appears in fields[].
 *
 * Confidence resolution order:
 *   1. If a matching entry already exists in fields[] — no-op, leave it as-is.
 *   2. field_confidences[key] — use the model-reported confidence for this key.
 *   3. 0.85 — default when the typed value is set but no confidence was provided.
 *
 * Pure function — returns a new fields[] array, does not mutate the input.
 *
 * @param extracted - The ExtractedClaim from the AI extractor.
 * @returns New fields[] array with any missing keys added.
 */
export function hydrateFieldsFromExtracted(extracted: ExtractedClaim): ExtractedField[] {
  const out: ExtractedField[] = [...extracted.fields];
  const existing = new Set(out.map((f) => f.field_key));
  const typed: ClaimFields | undefined = extracted.extracted_fields;

  if (!typed) return out;

  for (const key of HYDRATED_KEYS) {
    if (existing.has(key)) continue;
    const value = typed[key as keyof ClaimFields];
    if (typeof value !== "string" || value.trim() === "") continue;
    const conf = extracted.field_confidences[key] ?? 0.85;
    out.push({
      field_key: key,
      field_value: value.trim().slice(0, 2000),
      confidence: Math.max(0, Math.min(1, conf)),
      source: "ai",
    });
  }
  return out;
}

// ── PII scrub patterns ────────────────────────────────────────────────────────

/**
 * Argentine DNI: 7–8 contiguous digits, optionally dotted (e.g. 12.345.678).
 * Matches: 92310691, 9231069, 12.345.678
 */
const DNI_RE = /\b\d{1,2}\.?\d{3}\.?\d{3}\b/g;

/**
 * Generic claim/policy reference: 4+ uppercase-or-digit chars with optional dash + digits.
 * Covers siniestro refs like "91520998-2" and policy codes like "POL-12345".
 * Only redacts when the matched string is >= 6 chars total (avoids false positives on
 * common abbreviations like "AC6", "T01", etc.).
 */
const POLICY_RE = /\b[A-Z0-9]{4,}-?\d{1,4}\b/g;

/**
 * Scrub known PII values from the free-text fields summary, suggested_reply, and
 * not_relevant_reason.
 *
 * Replaces:
 *   - extracted full_name  → "el asegurado"
 *   - extracted dni        → "[DNI omitido]"
 *   - extracted policy_number → "[póliza omitida]"
 *   - any remaining DNI-pattern digits → "[DNI omitido]"
 *   - any remaining policy/ref pattern → "[ref. omitida]"
 *
 * Pure function — returns a new ExtractedClaim with scrubbed text fields.
 *
 * LLM06: The structured extracted_fields values (the canonical source) are NOT
 *        modified — only the free-text narrative fields are scrubbed.
 *
 * @param extracted - The ExtractedClaim from the AI extractor.
 * @returns New ExtractedClaim with scrubbed free-text fields.
 */
export function scrubPiiFromSummary(extracted: ExtractedClaim): ExtractedClaim {
  const fullName = extracted.extracted_fields?.full_name?.trim();
  const dniValue = extracted.extracted_fields?.dni?.trim();
  const policyValue = extracted.extracted_fields?.policy_number?.trim();

  const scrub = (s: string): string => {
    if (!s) return s;
    let out = s;

    // 1. Replace full name if we know it (case-insensitive, whole-token match).
    if (fullName && fullName.length >= 3) {
      const escaped = fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(escaped, "gi"), "el asegurado");
    }

    // 2. Replace extracted DNI value by its literal string.
    if (dniValue && /^\d[\d.]*$/.test(dniValue)) {
      out = out.replace(
        new RegExp(dniValue.replace(/[.]/g, "\\."), "g"),
        "[DNI omitido]"
      );
    }

    // 3. Replace extracted policy_number by its literal string.
    if (policyValue) {
      out = out.replace(
        new RegExp(policyValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        "[póliza omitida]"
      );
    }

    // 4. Generic fallback: catch any remaining DNI-pattern digits.
    out = out.replace(DNI_RE, "[DNI omitido]");

    // 5. Generic fallback: catch any remaining policy/claim reference patterns.
    out = out.replace(POLICY_RE, (m) => (m.length >= 6 ? "[ref. omitida]" : m));

    return out;
  };

  return {
    ...extracted,
    summary: scrub(extracted.summary ?? ""),
    suggested_reply: scrub(extracted.suggested_reply ?? ""),
    not_relevant_reason: extracted.not_relevant_reason
      ? scrub(extracted.not_relevant_reason)
      : extracted.not_relevant_reason,
  };
}
