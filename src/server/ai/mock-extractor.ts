/**
 * Mock AI extractor — deterministic local extraction, no OpenAI calls.
 *
 * AC9: MOCK_AI=true or missing OPENAI_API_KEY → uses this extractor.
 * AC8: Extraction completes in < 500ms deterministically.
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

// ── Field extractors ───────────────────────────────────────────────────────────

function extractDate(text: string): ExtractedField | null {
  const match = DATE_PATTERN.exec(text);
  if (!match) return null;
  return {
    field_key: "incident_date",
    field_value: match[1] ?? match[0],
    confidence: 0.85,
  };
}

function extractLocation(text: string): ExtractedField | null {
  const match = LOCATION_PATTERN.exec(text);
  if (!match) return null;
  return {
    field_key: "incident_location",
    field_value: match[0].trim().slice(0, 200),
    confidence: 0.75,
  };
}

function extractPlates(text: string): ExtractedField[] {
  const results: ExtractedField[] = [];
  const matches = [...text.matchAll(PLATE_PATTERN)];
  const unique = [...new Set(matches.map((m) => m[1]?.toUpperCase() ?? ""))];

  if (unique[0]) {
    results.push({
      field_key: "party_a_plate",
      field_value: unique[0],
      confidence: 0.90,
    });
    // Also add as vehicle_plate for non-choque types.
    results.push({
      field_key: "vehicle_plate",
      field_value: unique[0],
      confidence: 0.90,
    });
  }
  if (unique[1]) {
    results.push({
      field_key: "party_b_plate",
      field_value: unique[1],
      confidence: 0.88,
    });
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
  return {
    field_key: fieldKey,
    field_value: found ? "si" : "no",
    confidence: found ? confidence : 0.60,
  };
}

function extractPoliceReportNumber(text: string): ExtractedField | null {
  const match = POLICE_REPORT_PATTERN.exec(text);
  if (!match || !match[1]) return null;
  return {
    field_key: "police_report_number",
    field_value: match[1].trim(),
    confidence: 0.88,
  };
}

function extractDeclaredDamage(text: string, claimType: ClaimType): ExtractedField {
  // Look for damage description sentences.
  const keywords: Record<ClaimType, string[]> = {
    choque: ["daño", "abollon", "abollón", "choque", "impacto", "destruido", "rotura"],
    robo: ["robo", "sustracción", "robado", "faltaba", "faltaba", "desapareció"],
    granizo: ["granizo", "granizos", "granizada", "abollon", "abollón"],
    incendio: ["incendio", "fuego", "quemado", "carbonizado", "humo"],
  };

  const lower = text.toLowerCase();
  const hits = (keywords[claimType] ?? []).filter((kw) =>
    lower.includes(kw.toLowerCase())
  );

  if (hits.length === 0) {
    return {
      field_key: "declared_damage",
      field_value: "No especificado",
      confidence: 0.50,
    };
  }

  // Attempt to extract the sentence containing damage keywords.
  const sentences = text.split(/[.!?\n]+/);
  const damageSentence = sentences.find((s) =>
    hits.some((kw) => s.toLowerCase().includes(kw.toLowerCase()))
  );

  return {
    field_key: "declared_damage",
    field_value: (damageSentence ?? hits.join(", ")).trim().slice(0, 300),
    confidence: Math.min(0.50 + hits.length * 0.10, 0.80),
  };
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

const EXTRACTORS: Record<ClaimType, (text: string) => ExtractedField[]> = {
  choque: extractChoque,
  robo: extractRobo,
  granizo: extractGranizo,
  incendio: extractIncendio,
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
  for (const field of rawFields) {
    const existing = fieldMap.get(field.field_key);
    if (!existing || field.confidence > existing.confidence) {
      fieldMap.set(field.field_key, field);
    }
  }

  return {
    extraction_model: "mock-v1",
    fields: [...fieldMap.values()],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
  };
}
