/**
 * Gap analysis — compares extracted fields against required_docs_config
 * for a given claim type and determines which documents are missing.
 *
 * AC6: Missing docs written to missing_docs table; status → esperando.
 * AC5: All required docs present with confidence >= threshold → listo.
 * AC7: Low confidence (< threshold) on any required field → escalado.
 *
 * This is a pure function module — no DB calls, no side effects.
 * The extraction worker (worker/extract.ts) calls this and then writes results.
 */

import type { ClaimType } from "@/lib/schemas/cases";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";
import { getRequiredDocs } from "./required-docs";

/** Default confidence threshold from env or spec default 0.70. */
export const DEFAULT_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.CONFIDENCE_THRESHOLD ?? "0.70"
);

export interface GapAnalysisResult {
  /**
   * Missing required document keys.
   * A doc is "missing" if no extracted field covers it.
   * Note: extracted field keys and doc keys share the same namespace —
   * e.g. "denuncia_policial" is both a doc key and a field key mentioning
   * the police report was filed.
   */
  missing_doc_keys: string[];

  /**
   * Minimum confidence score across all required fields that WERE extracted.
   * null if no required fields were extracted at all.
   */
  confidence_min: number | null;

  /**
   * Required fields that were extracted but have confidence below threshold.
   * Used for audit_log.payload on escalado cases.
   */
  low_confidence_fields: Array<{ field_key: string; confidence: number }>;

  /**
   * Recommended next case status based on gap analysis:
   *   "listo"    — all required fields present + confidence >= threshold
   *   "esperando"— any required doc missing (need follow-up with insured)
   *   "escalado" — all docs present but confidence < threshold (human review)
   */
  recommended_status: "listo" | "esperando" | "escalado";
}

/**
 * Perform gap analysis for a given claim type against extracted fields.
 *
 * @param claimType   - The case claim type (choque, robo, granizo, incendio)
 * @param fields      - Extracted fields from the AI extractor
 * @param threshold   - Confidence threshold; defaults to CONFIDENCE_THRESHOLD env / 0.70
 */
export function analyzeGaps(
  claimType: ClaimType,
  fields: ExtractedField[],
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD
): GapAnalysisResult {
  const requiredDocs = getRequiredDocs(claimType);
  const extractedKeySet = new Set(fields.map((f) => f.field_key));
  const fieldsByKey = new Map(fields.map((f) => [f.field_key, f]));

  // 1. Find missing required doc keys.
  //    A required doc is "present" if at least one extracted field covers it.
  //    Field keys follow the convention: denuncia_policial, parte_amistoso, etc.
  //    We match doc_key against extracted field_key names.
  const missing_doc_keys = requiredDocs
    .filter((doc) => !extractedKeySet.has(doc.doc_key))
    .map((doc) => doc.doc_key);

  // 2. For docs that ARE present, gather confidence scores.
  const presentRequiredFields = requiredDocs
    .filter((doc) => extractedKeySet.has(doc.doc_key))
    .map((doc) => fieldsByKey.get(doc.doc_key)!);

  // 3. Compute confidence_min (min across present required fields).
  const confidence_min =
    presentRequiredFields.length > 0
      ? Math.min(...presentRequiredFields.map((f) => f.confidence))
      : null;

  // 4. Find required fields with low confidence.
  const low_confidence_fields = presentRequiredFields
    .filter((f) => f.confidence < threshold)
    .map((f) => ({ field_key: f.field_key, confidence: f.confidence }));

  // 5. Determine recommended status.
  let recommended_status: "listo" | "esperando" | "escalado";

  if (missing_doc_keys.length > 0) {
    // Missing required docs → need follow-up with insured.
    recommended_status = "esperando";
  } else if (low_confidence_fields.length > 0) {
    // All docs present but confidence too low → human review.
    recommended_status = "escalado";
  } else {
    // All docs present + all confidence >= threshold.
    recommended_status = "listo";
  }

  return {
    missing_doc_keys,
    confidence_min: confidence_min !== null ? parseFloat(confidence_min.toFixed(2)) : null,
    low_confidence_fields,
    recommended_status,
  };
}
