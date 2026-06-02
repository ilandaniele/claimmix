/**
 * Zod schema for the AI extractor output.
 *
 * LLM02: Model output is validated against this schema before any DB write.
 * No AI output can directly set case.status — only extracted_fields and
 * missing_docs flow through.
 *
 * AC8: Schema used for both real OpenAI extractor and mock extractor
 * to guarantee interface symmetry.
 */

import { z } from "zod";

/** Single extracted field with confidence score. */
export const ExtractedFieldSchema = z.object({
  /** Field key matching column family: incident_date, incident_location, etc. */
  field_key: z.string().min(1).max(100),
  /** Extracted value (string form of any field type). */
  field_value: z.string().max(2000),
  /** Confidence score 0.00–1.00 (numeric). */
  confidence: z.number().min(0).max(1),
});

export type ExtractedField = z.infer<typeof ExtractedFieldSchema>;

/** Full extraction result returned by any extractor (real or mock). */
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
});

export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;

/**
 * JSON schema object for OpenAI structured output (response_format).
 * LLM02: strict=true prevents arbitrary JSON shape from the model.
 *
 * This must stay in sync with ExtractedClaimSchema above.
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
            },
            required: ["field_key", "field_value", "confidence"],
            additionalProperties: false,
          },
        },
        prompt_tokens: { type: "integer" },
        completion_tokens: { type: "integer" },
        cost_usd: { type: "number" },
      },
      required: [
        "extraction_model",
        "fields",
        "prompt_tokens",
        "completion_tokens",
        "cost_usd",
      ],
      additionalProperties: false,
    },
  },
};
