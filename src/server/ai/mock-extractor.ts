/**
 * Mock AI extractor — deterministic local extraction, no OpenAI calls.
 *
 * AC9:  MOCK_AI=true or missing OPENAI_API_KEY → uses this extractor.
 * AC8:  Extraction completes in < 500ms deterministically.
 * W3:   extractEmailClaimMock() added for unit testing the email claim pipeline.
 *
 * Extraction strategy:
 *   - Date: regex for DD/MM/YYYY or YYYY-MM-DD patterns in the text.
 *   - Location: looks for "calle", "avenida", "Av.", "esquina" patterns.
 *   - Plate:    Argentine plate regex — AAA 123 (old) or AA 123 BB (mercosur).
 *   - Boolean docs: keyword presence check (denuncia, VTV, bomberos, etc.)
 *   - Confidence: scaled by keyword match quality (0.50–0.95 range per spec).
 *
 * Same interface as the OpenAI extractor (ExtractedClaim type).
 * The worker uses this transparently when MOCK_AI=true.
 */

import type { ClaimType } from "@/lib/schemas/cases";
import type { ExtractedClaim, ExtractedField } from "@/lib/schemas/extracted-claim";

// ── Regex patterns ─────────────────────────────────────────────────────────────

/** Argentine date: DD/MM/YYYY or YYYY-MM-DD. */
const DATE_PATTERN = /\b(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\b/;

/** Argentine street / location indicators. */
const LOCATION_PATTERN =
  /\b(?:calle|Calle|Av\.|Avenida|avenida|esquina|intersección|cruce|altura|cuadra|boulevard|blvd\.)\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ\s\d.]+(?:\d+)?/i;

/** Argentine license plates:
 *   Old format:  ABC 123 or ABC123
 *   Mercosur:    AB 123 CD or AB123CD
 */
const PLATE_PATTERN = /\b([A-Z]{2,3}\s?\d{3}\s?[A-Z]{0,2})\b/g;

/**
 * Police report number pattern.
 * Matches patterns like:
 *   "número de denuncia 2024-CABA-00834"
 *   "denuncia n° 2024-12345"
 *   "denuncia nro. 789/2024"
 *   "número de expediente 789/2024"
 *   "denuncia: 3421/2024"
 */
const POLICE_REPORT_PATTERN =
  /(?:n[úu]mero(?:\s+de)?\s+(?:denuncia|expediente|exp\.?)|bajo\s+el\s+n[úu]mero\s+de\s+denuncia|denuncia\s+(?:n[°º]|nro\.?|número)\s*\.?\s*|denuncia\s*:\s*)\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i;

// ── Field helper ──────────────────────────────────────────────────────────────

/**
 * Build an ExtractedField with source='ai' (default for mock extractor).
 * All mock-extracted fields originate from regex/keyword matching, not memory.
 */
function field(
  field_key: string,
  field_value: string,
  confidence: number
): ExtractedField {
  return { field_key, field_value, confidence, source: "ai" };
}

// ── Field extractors ───────────────────────────────────────────────────────────

function extractDate(text: string): ExtractedField | null {
  const match = DATE_PATTERN.exec(text);
  if (!match) return null;
  return field("incident_date", match[1] ?? match[0], 0.85);
}

function extractLocation(text: string): ExtractedField | null {
  const match = LOCATION_PATTERN.exec(text);
  if (!match) return null;
  return field("incident_location", match[0].trim().slice(0, 200), 0.75);
}

function extractPlates(text: string): ExtractedField[] {
  const results: ExtractedField[] = [];
  const matches = [...text.matchAll(PLATE_PATTERN)];
  const unique = [...new Set(matches.map((m) => m[1]?.toUpperCase() ?? ""))];

  if (unique[0]) {
    results.push(field("party_a_plate", unique[0], 0.90));
    // Also add as vehicle_plate for non-choque types.
    results.push(field("vehicle_plate", unique[0], 0.90));
  }
  if (unique[1]) {
    results.push(field("party_b_plate", unique[1], 0.88));
  }
  return results;
}

function extractBoolean(
  text: string,
  keywords: string[],
  fieldKey: string,
  confidence: number
): ExtractedField {
  const lower = text.toLowerCase();
  const found = keywords.some((kw) => lower.includes(kw.toLowerCase()));
  return field(fieldKey, found ? "si" : "no", found ? confidence : 0.60);
}

function extractPoliceReportNumber(text: string): ExtractedField | null {
  const match = POLICE_REPORT_PATTERN.exec(text);
  if (!match || !match[1]) return null;
  return field("police_report_number", match[1].trim(), 0.88);
}

function extractDeclaredDamage(text: string, claimType: ClaimType): ExtractedField {
  // Look for damage description sentences.
  const keywords: Record<ClaimType, string[]> = {
    choque: ["daño", "abollon", "abollón", "choque", "impacto", "destruido", "rotura"],
    robo: ["robo", "sustracción", "robado", "faltaba", "faltaba", "desapareció"],
    granizo: ["granizo", "granizos", "granizada", "abollon", "abollón"],
    incendio: ["incendio", "fuego", "quemado", "carbonizado", "humo"],
    cristales: ["vidrio", "cristal", "parabrisas", "luneta", "ventanilla", "roto", "fisura"],
    rc: ["tercero", "tercer", "responsabilidad", "otro vehículo", "conductor", "daños a"],
    robo_contenido: ["robaron", "me llevaron", "sustrajeron", "bolso", "notebook", "cámara", "objetos"],
    accidente_personal: ["fractura", "lesión", "herida", "hospital", "guardia", "médico", "yeso"],
    other: [],
  };

  const lower = text.toLowerCase();
  const hits = (keywords[claimType] ?? []).filter((kw) =>
    lower.includes(kw.toLowerCase())
  );

  if (hits.length === 0) {
    return field("declared_damage", "No especificado", 0.50);
  }

  // Attempt to extract the sentence containing damage keywords.
  const sentences = text.split(/[.!?\n]+/);
  const damageSentence = sentences.find((s) =>
    hits.some((kw) => s.toLowerCase().includes(kw.toLowerCase()))
  );

  return field(
    "declared_damage",
    (damageSentence ?? hits.join(", ")).trim().slice(0, 300),
    Math.min(0.50 + hits.length * 0.10, 0.80)
  );
}

// ── Per-claim-type extraction ──────────────────────────────────────────────────

function extractChoque(text: string): ExtractedField[] {
  const fields: ExtractedField[] = [];

  const dateField = extractDate(text);
  if (dateField) fields.push(dateField);

  const locationField = extractLocation(text);
  if (locationField) {
    fields.push({ ...locationField, field_key: "incident_location" });
  }

  fields.push(...extractPlates(text));
  fields.push(extractDeclaredDamage(text, "choque"));
  fields.push(
    extractBoolean(text, ["parte amistoso", "parte de accidente", "formulario amistoso"], "parte_amistoso", 0.85)
  );
  fields.push(
    extractBoolean(text, ["foto", "imagen", "adjunto foto", "adjuntos"], "fotos_danos", 0.80)
  );
  fields.push(
    extractBoolean(text, ["licencia", "carnet", "registro de conducir"], "licencia_conducir", 0.82)
  );

  return fields;
}

function extractRobo(text: string): ExtractedField[] {
  const fields: ExtractedField[] = [];

  const dateField = extractDate(text);
  if (dateField) fields.push(dateField);

  const locationField = extractLocation(text);
  if (locationField) {
    fields.push({ ...locationField, field_key: "incident_location" });
  }

  fields.push(...extractPlates(text));
  fields.push(extractDeclaredDamage(text, "robo"));
  fields.push(
    extractBoolean(
      text,
      ["denuncia policial", "radicamos denuncia", "hice la denuncia", "denuncia ante", "comisaría"],
      "denuncia_policial",
      0.87
    )
  );
  fields.push(
    extractBoolean(text, ["foto del lugar", "fotos del lugar", "imágenes del lugar"], "fotos_lugar", 0.78)
  );

  const reportNumber = extractPoliceReportNumber(text);
  if (reportNumber) fields.push(reportNumber);

  return fields;
}

function extractGranizo(text: string): ExtractedField[] {
  const fields: ExtractedField[] = [];

  const dateField = extractDate(text);
  if (dateField) fields.push(dateField);

  const locationField = extractLocation(text);
  if (locationField) {
    fields.push({ ...locationField, field_key: "incident_location" });
  }

  fields.push(...extractPlates(text));
  fields.push(extractDeclaredDamage(text, "granizo"));
  // foto_oblea_vtv: the PHOTO of the VTV sticker must be mentioned, not just VTV itself.
  // Keywords indicating the photo/attachment is present.
  fields.push(
    extractBoolean(
      text,
      ["oblea vtv", "foto de la oblea", "foto oblea", "adjunto oblea", "imagen oblea", "foto vtv", "adjunto vtv"],
      "foto_oblea_vtv",
      0.85
    )
  );
  fields.push(
    extractBoolean(
      text,
      ["foto", "imagen", "adjunto foto", "fotos de los daños", "fotos del granizo"],
      "fotos_danos",
      0.80
    )
  );

  return fields;
}

function extractIncendio(text: string): ExtractedField[] {
  const fields: ExtractedField[] = [];

  const dateField = extractDate(text);
  if (dateField) fields.push(dateField);

  const locationField = extractLocation(text);
  if (locationField) {
    fields.push({ ...locationField, field_key: "incident_location" });
  }

  fields.push(...extractPlates(text));
  fields.push(extractDeclaredDamage(text, "incendio"));
  fields.push(
    extractBoolean(
      text,
      ["informe de bomberos", "bomberos", "cuerpo de bomberos", "certificado de bomberos"],
      "informe_bomberos",
      0.87
    )
  );
  fields.push(
    extractBoolean(
      text,
      ["foto", "imagen", "adjunto foto", "fotos del incendio", "fotos de los daños"],
      "fotos_danos",
      0.80
    )
  );
  fields.push(
    extractBoolean(
      text,
      ["denuncia policial", "radicamos denuncia", "hice la denuncia", "comisaría"],
      "denuncia_policial",
      0.85
    )
  );

  return fields;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Fallback extractor for unknown/other claim types — returns minimal extracted fields. */
function extractOther(text: string): ExtractedField[] {
  const fields: ExtractedField[] = [];
  const dateMatch = /(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/.exec(text);
  if (dateMatch) {
    fields.push(field("incident_date", dateMatch[1]!, 0.55));
  }
  fields.push(extractDeclaredDamage(text, "other"));
  return fields;
}

const EXTRACTORS: Record<ClaimType, (text: string) => ExtractedField[]> = {
  choque: extractChoque,
  robo: extractRobo,
  granizo: extractGranizo,
  incendio: extractIncendio,
  // New types: use the generic extractor which still captures date, location, plate, damage.
  cristales: extractOther,
  rc: extractOther,
  robo_contenido: extractOther,
  accidente_personal: extractOther,
  other: extractOther,
};

/**
 * Run the mock extractor on the given raw text.
 *
 * AC9: Same interface as real OpenAI extractor.
 * extraction_model = "mock-v1".
 * No OpenAI call is made.
 *
 * @param rawText   - Raw email body.
 * @param claimType - Claim type to determine which fields to extract.
 */
export function runMockExtractor(
  rawText: string,
  claimType: ClaimType
): ExtractedClaim {
  const extractor = EXTRACTORS[claimType];
  const rawFields = extractor(rawText);

  // Deduplicate: if the same field_key appears multiple times, keep highest-confidence.
  const fieldMap = new Map<string, ExtractedField>();
  for (const f of rawFields) {
    const existing = fieldMap.get(f.field_key);
    if (!existing || f.confidence > existing.confidence) {
      fieldMap.set(f.field_key, f);
    }
  }

  return {
    extraction_model: "mock-v1",
    fields: [...fieldMap.values()],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    // Email-intake extensions — defaults for mock extractor
    is_claim: true,
    confidence: 0.90,
    extracted_fields: undefined,
    field_confidences: {},
    missing_fields: [],
    fields_pending_confirmation: [],
    possible_customer_matches: [],
    possible_policy_matches: [],
    severity: null,
    requires_specialist: false,
    not_relevant_reason: undefined,
    summary: "",
    suggested_reply: "",
  };
}

/**
 * Mock extractor for the email claim extraction pipeline (W3).
 *
 * Used when AI_MOCK=true env var is set or when OPENAI_API_KEY is absent.
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
