/**
 * Denuncia simulada, sin llamar a ningún modelo.
 *
 * Lo elige `resolveExtractionEngine` (src/server/ai/provider.ts): MOCK_AI=true,
 * AI_MOCK=true, o Gemini sin configurar. No hay interruptor por OPENAI_API_KEY:
 * OpenAI se sacó del producto y esa variable no se lee en ningún lado.
 *
 * El pipeline en modo mock llama a denunciaSimuladaVacia(), que no inventa ningún
 * dato. extractEmailClaimMock() queda como base de esa denuncia y como constructor
 * de fixtures para tests.
 */

import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";

/** Lo que devuelve el pipeline con MOCK_AI: nada inventado, derivado a una persona. */
export function denunciaSimuladaVacia(): ExtractedClaim {
  return extractEmailClaimMock({
    is_claim: true,
    confidence: 0,
    severity: "critical",
    requires_specialist: true,
    fields: [],
    extracted_fields: {},
    field_confidences: {},
    missing_fields: [],
    fields_pending_confirmation: [],
    summary: "Extracción simulada (MOCK_AI): sin datos.",
    suggested_reply: "",
    extraction_model: "mock-email-v1",
  });
}

/**
 * Mock extractor for the email claim extraction pipeline (W3).
 *
 * E16: la denuncia fija de acá abajo (Juan Pérez, POL-1234, etc.) es sólo un
 * constructor de fixtures para tests — el pipeline real en modo mock usa
 * denunciaSimuladaVacia(), que no inventa ningún dato.
 * Accepts overrides to simulate specific test scenarios without real LLM calls.
 *
 * Returned output:
 *   - is_claim: true (default; override to test non-claim path)
 *   - severity: 'medium' (default)
 *   - All standard claim fields populated at high confidence (≥ 0.85)
 *   - missing_fields: [] by default
 *   - fields_pending_confirmation: [] by default
 *
 * AC5:  Set { is_claim: false } to test no_relevante path.
 * AC8:  Set { missing_fields: ['dni'] } to test missing doc path.
 * AC11: Set { severity: 'critical', requires_specialist: true } to test escalation.
 * AC25: Prompt injection tests pass overrides — mock output is not affected by input text.
 *
 * @param overrides - Partial<ExtractedClaim> to merge into the default mock output.
 */
export function extractEmailClaimMock(
  overrides?: Partial<ExtractedClaim>
): ExtractedClaim {
  const base: ExtractedClaim = {
    extraction_model: "mock-email-v1",
    fields: [
      { field_key: "full_name",            field_value: "Juan Pérez",          confidence: 0.92, source: "ai" },
      { field_key: "email",                field_value: "juan@example.com",    confidence: 0.95, source: "ai" },
      { field_key: "phone",                field_value: "+54 11 1234-5678",    confidence: 0.88, source: "ai" },
      { field_key: "policy_number",        field_value: "POL-1234",            confidence: 0.90, source: "ai" },
      { field_key: "accident_date",        field_value: "2024-03-15",          confidence: 0.90, source: "ai" },
      { field_key: "accident_location",    field_value: "Av. Corrientes 1234", confidence: 0.85, source: "ai" },
      { field_key: "accident_description", field_value: "Choque en intersección", confidence: 0.87, source: "ai" },
      { field_key: "claim_type",           field_value: "choque",              confidence: 0.88, source: "ai" },
    ],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    is_claim: true,
    confidence: 0.92,
    extracted_fields: {
      full_name: "Juan Pérez",
      email: "juan@example.com",
      phone: "+54 11 1234-5678",
      policy_number: "POL-1234",
      accident_date: "2024-03-15",
      accident_location: "Av. Corrientes 1234",
      accident_description: "Choque en intersección",
      claim_type: "choque",
    },
    field_confidences: {
      full_name: 0.92,
      email: 0.95,
      phone: 0.88,
      policy_number: 0.90,
      accident_date: 0.90,
      accident_location: 0.85,
      accident_description: 0.87,
      claim_type: 0.88,
    },
    missing_fields: [],
    fields_pending_confirmation: [],
    possible_customer_matches: [],
    possible_policy_matches: [],
    severity: "medium",
    requires_specialist: false,
    not_relevant_reason: undefined,
    fraud_risk_level: "none",
    fraud_indicators: [],
    adjuntos: [],
    mecanica: null,
    injury_severity: null,
    summary: "Siniestro de choque reportado por Juan Pérez el 15/03/2024 en Av. Corrientes 1234.",
    suggested_reply: "",
  };

  if (!overrides) return base;

  // Deep-merge overrides (shallow merge fields array — caller replaces entirely).
  return {
    ...base,
    ...overrides,
    // Merge extracted_fields if both provided.
    extracted_fields:
      overrides.extracted_fields !== undefined
        ? overrides.extracted_fields
        : base.extracted_fields,
    // Merge field_confidences.
    field_confidences:
      overrides.field_confidences !== undefined
        ? { ...base.field_confidences, ...overrides.field_confidences }
        : base.field_confidences,
  };
}
