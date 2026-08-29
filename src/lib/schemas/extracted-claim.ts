/**
 * Zod schema for the AI extractor output.
 *
 * LLM02: Model output is validated against this schema before any DB write.
 * No AI output can directly set case.status — only extracted_fields and
 * missing_docs flow through.
 *
 * AC8: Schema used for both real OpenAI extractor and mock extractor
 * to guarantee interface symmetry.
 *
 * Extended in W1 (email-intake) with:
 *   - is_claim / confidence: classifier output (AC1, AC5)
 *   - extracted_fields: typed ClaimFields with per-field confidence (AC6–AC9)
 *   - severity: from severity classifier (AC11, AC15)
 *   - requires_specialist: escalation flag (AC11)
 *   - possible_customer_matches / possible_policy_matches: matching hints (AC22)
 *   - fields_pending_confirmation: field keys flagged for confirmation (AC7)
 *   - missing_fields: field keys below confidence threshold (AC8)
 *   - summary / suggested_reply: human-readable summaries for outbound templates
 */

import { z } from "zod";
import { SeveritySchema } from "@/lib/schemas/cases";

/** Single extracted field with confidence score. */
export const ExtractedFieldSchema = z.object({
  /** Field key matching column family: incident_date, incident_location, etc. */
  field_key: z.string().min(1).max(100),
  /** Extracted value (string form of any field type). */
  field_value: z.string().max(2000),
  /** Confidence score 0.00–1.00 (numeric). */
  confidence: z.number().min(0).max(1),
  /**
   * Source of this field value.
   * 'ai' — extracted by LLM from email body (default)
   * 'memory' — recalled from claim_memory for this sender (AC13)
   * 'confirmed' — previously confirmed by analyst
   */
  source: z.enum(["ai", "memory", "confirmed"]).default("ai"),
});

export type ExtractedField = z.infer<typeof ExtractedFieldSchema>;

/**
 * Structured claim field keys extracted from an email body.
 * These correspond to the field_key values stored in extracted_fields table.
 * All values are strings; dates as ISO strings, amounts as numeric strings.
 */
export const ClaimFieldsSchema = z.object({
  full_name: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  dni: z.string().max(20).optional(),          // Argentine national ID [PII]
  policy_number: z.string().max(100).optional(), // [PII]
  accident_date: z.string().max(50).optional(), // ISO date or human date string
  accident_location: z.string().max(500).optional(),
  accident_description: z.string().max(5000).optional(),
  claim_type: z.string().max(50).optional(),   // choque, robo, granizo, incendio, etc.
});

export type ClaimFields = z.infer<typeof ClaimFieldsSchema>;

/**
 * Las nueve claves, derivadas del esquema y no escritas a mano.
 *
 * Estaban copiadas en dos lugares más: `HYDRATED_KEYS` en
 * `server/ai/hydrate-fields.ts` y una escalera de nueve `if` en el worker, para
 * armar lo que se le pasa al buscador de clientes. Agregar un campo al esquema
 * obligaba a acordarse de los tres; el que quedara sin tocar simplemente no
 * veía el campo nuevo, sin ningún error.
 *
 * `z.object` conserva el orden de declaración, así que esto también fija el
 * orden, que es el del esquema.
 */
export const CLAIM_FIELD_KEYS = Object.keys(ClaimFieldsSchema.shape) as Array<
  keyof ClaimFields
>;

/**
 * A possible customer match returned by the AI extractor.
 * The actual match is confirmed server-side by the customer-matcher module.
 * This is an advisory hint, not authoritative.
 */
export const PossibleCustomerMatchSchema = z.object({
  customer_id: z.string().uuid(),
  match_score: z.number().min(0).max(1),
  match_reason: z.enum(["email", "dni", "phone", "name"]),
});

export type PossibleCustomerMatch = z.infer<typeof PossibleCustomerMatchSchema>;

/**
 * A possible policy match returned by the AI extractor.
 */
export const PossiblePolicyMatchSchema = z.object({
  policy_id: z.string().uuid(),
  policy_number: z.string(),
  match_score: z.number().min(0).max(1),
});

export type PossiblePolicyMatch = z.infer<typeof PossiblePolicyMatchSchema>;

/**
 * Full extraction result returned by any extractor (real or mock).
 * Extended with email-intake fields for the claims workflow.
 */
export const ExtractedClaimSchema = z.object({
  /**
   * Model identifier for provenance tracking.
   * Real extractor: "gpt-4o-mini"
   * Mock extractor: "mock-v1"
   */
  extraction_model: z.string().min(1).max(50),

  /** Array of extracted fields. May be partial if text is incomplete. */
  fields: z.array(ExtractedFieldSchema),

  /**
   * Prompt tokens consumed — 0 for mock extractor.
   * Used for ai_usage budget tracking.
   */
  prompt_tokens: z.number().int().min(0),

  /** Completion tokens consumed — 0 for mock extractor. */
  completion_tokens: z.number().int().min(0),

  /**
   * Estimated cost in USD for this extraction.
   * 0.0 for mock extractor.
   */
  cost_usd: z.number().min(0),

  // ── Email-intake extensions ──────────────────────────────────────────────

  /**
   * Whether this email is an insurance claim.
   * null = could not determine (fallback: treat as claim and proceed).
   * Corresponds to cases.is_claim column.
   */
  is_claim: z.boolean().nullable().default(null),

  /**
   * Classifier confidence that this email is a claim (0.00–1.00).
   * IC9: High ≥ 0.85 → proceed. Medium 0.60–0.85 → confirmacion_pendiente.
   *      Low < 0.60 → treated as missing.
   */
  confidence: z.number().min(0).max(1).default(0),

  /**
   * Structured claim field values extracted from the email body.
   * Parallel to the `fields` array but in typed object form for
   * downstream use by customer-matcher and gap-analyzer.
   */
  extracted_fields: ClaimFieldsSchema.optional(),

  /**
   * Per-field confidence scores, keyed by ClaimFields field name.
   * If a field is absent here, treat its confidence as 0.
   */
  field_confidences: z.record(z.string(), z.number().min(0).max(1)).default({}),

  /**
   * Field keys that the extractor flagged as missing or low-confidence.
   * Used by gap-analyzer to create missing_docs rows (AC8, AC10).
   */
  missing_fields: z.array(z.string()).default([]),

  /**
   * Field keys that require analyst confirmation before proceeding.
   * Set when confidence is medium (0.60–0.85) or conflict detected (AC7, AC9).
   */
  fields_pending_confirmation: z.array(z.string()).default([]),

  /**
   * Advisory customer match hints from the extractor.
   * Server-side customer-matcher module runs the authoritative match.
   */
  possible_customer_matches: z.array(PossibleCustomerMatchSchema).default([]),

  /**
   * Advisory policy match hints from the extractor.
   */
  possible_policy_matches: z.array(PossiblePolicyMatchSchema).default([]),

  /**
   * Severity level determined by the severity classifier.
   * null = not yet classified.
   */
  severity: SeveritySchema.nullable().default(null),

  /**
   * Whether this claim requires a specialist (AC11).
   * Set when severity = 'high' or 'critical', or when LLM signals complex case.
   */
  requires_specialist: z.boolean().default(false),

  /**
   * Reason why this email was classified as not a claim.
   * Only set when is_claim = false (AC5).
   */
  not_relevant_reason: z.string().max(500).optional(),

  /**
   * Short human-readable summary of the claim for the outbound email templates.
   * LLM02: Used only in templates — never echoed back as structured data.
   */
  summary: z.string().max(2000).default(""),

  /**
   * Suggested reply text for the analyst to review before sending.
   * Not used directly — templates are rendered server-side.
   */
  suggested_reply: z.string().max(5000).default(""),

  /**
   * Set by the extractor (never by the model) when BOTH OpenAI attempts
   * returned unparseable output and the safe default was used. Consumed by
   * the trainability assessment — a run without valid JSON can never be
   * suggested (or approved) as a training example.
   */
  parse_failed: z.boolean().optional(),

  // ── Fraud risk assessment ─────────────────────────────────────────────────

  /**
   * Overall fraud risk level determined by the extractor based on
   * inconsistencies, behavioral signals, and claim patterns.
   */
  fraud_risk_level: z.enum(["none", "low", "medium", "high"]).default("none"),

  /**
   * Specific fraud indicators found in the claim.
   * Each indicator has a type and a human-readable description.
   */
  fraud_indicators: z.array(
    z.object({
      type: z.enum([
        "timeline_inconsistency",
        "location_inconsistency",
        "damage_inconsistency",
        "documentation_gap",
        "repeat_claimant",
        "behavior_signal",
        "other",
      ]),
      description: z.string().max(500),
    })
  ).default([]),

  // ── Granular injury severity ──────────────────────────────────────────────

  /**
   * Granular injury severity derived from claim content.
   * null = not applicable (no injury claim) or could not determine.
   */
  injury_severity: z.enum(["none", "minor", "severe", "fatal"]).nullable().default(null),
});

export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;

/**
 * JSON schema object for OpenAI structured output (response_format).
 * LLM02: strict=true prevents arbitrary JSON shape from the model.
 *
 * This must stay in sync with ExtractedClaimSchema above.
 * Extended with email-intake fields.
 */
export const OPENAI_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "extracted_claim",
    strict: true,
    schema: {
      type: "object",
      properties: {
        extraction_model: { type: "string" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field_key: { type: "string" },
              field_value: { type: "string" },
              confidence: { type: "number" },
              source: { type: "string" },
            },
            required: ["field_key", "field_value", "confidence", "source"],
            additionalProperties: false,
          },
        },
        prompt_tokens: { type: "integer" },
        completion_tokens: { type: "integer" },
        cost_usd: { type: "number" },
        is_claim: { type: ["boolean", "null"] },
        confidence: { type: "number" },
        extracted_fields: {
          type: "object",
          properties: {
            full_name: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            dni: { type: "string" },
            policy_number: { type: "string" },
            accident_date: { type: "string" },
            accident_location: { type: "string" },
            accident_description: { type: "string" },
            claim_type: { type: "string" },
          },
          required: [
            "full_name",
            "email",
            "phone",
            "dni",
            "policy_number",
            "accident_date",
            "accident_location",
            "accident_description",
            "claim_type",
          ],
          additionalProperties: false,
        },
        field_confidences: {
          type: "object",
          additionalProperties: { type: "number" },
        },
        missing_fields: { type: "array", items: { type: "string" } },
        fields_pending_confirmation: { type: "array", items: { type: "string" } },
        possible_customer_matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              customer_id: { type: "string" },
              match_score: { type: "number" },
              match_reason: { type: "string" },
            },
            required: ["customer_id", "match_score", "match_reason"],
            additionalProperties: false,
          },
        },
        possible_policy_matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              policy_id: { type: "string" },
              policy_number: { type: "string" },
              match_score: { type: "number" },
            },
            required: ["policy_id", "policy_number", "match_score"],
            additionalProperties: false,
          },
        },
        severity: { type: ["string", "null"] },
        requires_specialist: { type: "boolean" },
        not_relevant_reason: { type: "string" },
        summary: { type: "string" },
        suggested_reply: { type: "string" },
        fraud_risk_level: { type: "string", enum: ["none", "low", "medium", "high"] },
        fraud_indicators: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              description: { type: "string" },
            },
            required: ["type", "description"],
            additionalProperties: false,
          },
        },
        injury_severity: { type: ["string", "null"] },
      },
      required: [
        "extraction_model",
        "fields",
        "prompt_tokens",
        "completion_tokens",
        "cost_usd",
        "is_claim",
        "confidence",
        "extracted_fields",
        "field_confidences",
        "missing_fields",
        "fields_pending_confirmation",
        "possible_customer_matches",
        "possible_policy_matches",
        "severity",
        "requires_specialist",
        "not_relevant_reason",
        "summary",
        "suggested_reply",
        "fraud_risk_level",
        "fraud_indicators",
        "injury_severity",
      ],
      additionalProperties: false,
    },
  },
};
