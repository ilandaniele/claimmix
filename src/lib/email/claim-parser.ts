import type { ExtractedField } from "@/lib/schemas/extracted-claim";

type ParseInput = {
  subject?: string | null;
  body?: string | null;
  senderEmail?: string | null;
};

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const DNI_RE = /\b(?:DU|DNI)\s*(?:Nro\.?|N[ro]*\.?|No\.?)?\s*:?\s*([0-9.]{7,12})(?=\D|$)/i;
const CBU_RE = /\bCBU\s*(?:Nro\.?|N[ro]*\.?|No\.?)?\s*:?\s*([0-9]{18,24})(?=\D|$)/i;
const CLAIM_REF_RE = /\bSiniestro\s+([A-Z0-9][A-Z0-9-]{4,})\b/i;
const ACCIDENT_DATE_RE = /\bAccidente\s+del\s+(\d{1,2}\/\d{1,2}\/\d{4})\b/i;
const DATE_RE = /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/;
const PLATE_PATTERN_SOURCE = "[A-Z]{2}\\s?\\d{3}\\s?[A-Z]{2}|[A-Z]{3}\\s?\\d{3}";
const PLATE_RE = new RegExp(`\\bdominio\\s+(${PLATE_PATTERN_SOURCE})\\b`, "gi");
const PERSON_DNI_RE =
  /\bpersona\s+([A-Z][A-Z\s.'-]{3,120}?)\s+con\s+(?:DU|DNI)\s*(?:Nro\.?|N[ro]*\.?|No\.?)?\s*:?\s*[0-9.]{7,12}(?=\D|$)/i;
const GREETING_NAME_RE =
  /\bEstimad[oa]\s+(?:Sr\.?|Sra\.?)\s+([A-Z][A-Z\s.'-]{3,80}?)(?:,|\n|\r)/i;

const FIELD_CONFIDENCE: Record<string, number> = {
  full_name: 0.92,
  email: 0.9,
  dni: 0.94,
  cbu: 0.94,
  policy_number: 0.86,
  accident_date: 0.9,
  accident_description: 0.82,
  claim_type: 0.86,
  party_a_plate: 0.9,
  party_b_plate: 0.9,
  party_a_vehicle: 0.82,
  party_b_vehicle: 0.82,
  insurer: 0.82,
};

export function parseEmailClaimFields(input: ParseInput): ExtractedField[] {
  const subject = cleanText(input.subject ?? "");
  const body = cleanText(input.body ?? "");
  const text = `${subject}\n${body}`;
  const fields: ExtractedField[] = [];

  addField(fields, "full_name", extractFullName(text));
  addField(fields, "email", extractEmail(text, input.senderEmail));
  addField(fields, "dni", normalizeDni(matchValue(DNI_RE, text)));
  addField(fields, "cbu", normalizeDigits(matchValue(CBU_RE, text)));
  addField(fields, "policy_number", matchValue(CLAIM_REF_RE, subject) ?? matchValue(CLAIM_REF_RE, text));
  addField(fields, "accident_date", matchValue(ACCIDENT_DATE_RE, subject) ?? matchValue(DATE_RE, subject));
  addField(fields, "claim_type", inferClaimType(text));
  addField(fields, "insurer", extractInsurer(subject));
  addField(fields, "accident_description", extractAccidentDescription(subject));

  const plates = [...subject.matchAll(PLATE_RE)].map((m) => normalizePlate(m[1] ?? ""));
  if (plates[0]) addField(fields, "party_a_plate", plates[0]);
  if (plates[1]) addField(fields, "party_b_plate", plates[1]);

  const vehicles = extractVehicles(subject);
  if (vehicles[0]) addField(fields, "party_a_vehicle", vehicles[0]);
  if (vehicles[1]) addField(fields, "party_b_vehicle", vehicles[1]);

  return fields;
}

export function mergeExtractedFields(
  primary: ExtractedField[],
  fallback: ExtractedField[]
): ExtractedField[] {
  const byKey = new Map<string, ExtractedField>();

  for (const field of primary) {
    const value = field.field_value.trim();
    if (!value) continue;

    const existing = byKey.get(field.field_key);
    if (!existing || existing.field_value.trim() === "" || field.confidence > existing.confidence) {
      byKey.set(field.field_key, { ...field, field_value: value.slice(0, 2000) });
    }
  }

  for (const field of fallback) {
    const value = field.field_value.trim();
    if (!value || byKey.has(field.field_key)) continue;
    byKey.set(field.field_key, { ...field, field_value: value.slice(0, 2000) });
  }

  return [...byKey.values()];
}

function addField(fields: ExtractedField[], key: string, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed) return;

  fields.push({
    field_key: key,
    field_value: trimmed.slice(0, 2000),
    confidence: FIELD_CONFIDENCE[key] ?? 0.8,
    source: "ai",
  });
}

function cleanText(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchValue(pattern: RegExp, text: string): string | null {
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  return match?.[1]?.trim() ?? null;
}

function extractFullName(text: string): string | null {
  const cbuName = matchValue(PERSON_DNI_RE, text);
  if (cbuName) return titleCase(cbuName);

  const greetingName = matchValue(GREETING_NAME_RE, text);
  if (!greetingName) return null;

  const parts = greetingName.trim().split(/\s+/);
  if (parts.length === 2) {
    return titleCase(`${parts[1]} ${parts[0]}`);
  }
  return titleCase(greetingName);
}

function extractEmail(text: string, senderEmail?: string | null): string | null {
  const match = EMAIL_RE.exec(text);
  return match?.[0] ?? senderEmail?.trim() ?? null;
}

function inferClaimType(text: string): string | null {
  const folded = fold(text);
  if (/\b(robo|robado|sustraccion)\b/.test(folded)) return "robo";
  if (/\b(incendio|fuego|quemad[oa])\b/.test(folded)) return "incendio";
  if (/\b(granizo|granizada)\b/.test(folded)) return "granizo";
  if (/\b(accidente|choque|colision)\b/.test(folded)) return "choque";
  return null;
}

function extractInsurer(subject: string): string | null {
  const match = /\bSiniestro\s+[A-Z0-9-]+\s+de\s+(.+?)\s+-\s+Accidente\b/i.exec(subject);
  return match?.[1]?.trim() ?? null;
}

function extractAccidentDescription(subject: string): string | null {
  const match = /\bAccidente\s+del\s+\d{1,2}\/\d{1,2}\/\d{4}\s+(.+)$/i.exec(subject);
  if (!match?.[1]) return null;
  return `Accidente ${match[1].trim()}`;
}

function extractVehicles(subject: string): string[] {
  const platePattern = new RegExp(PLATE_PATTERN_SOURCE, "i");
  const first = new RegExp(`entre\\s+(.+?)\\s+dominio\\s+${platePattern.source}`, "i").exec(subject)?.[1];
  const second = new RegExp(`\\sy\\s+(.+?)\\s+dominio\\s+${platePattern.source}`, "i").exec(subject)?.[1];
  return [first, second].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim());
}

function normalizePlate(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

function normalizeDni(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\./g, "").replace(/\D+$/g, "");
  return normalized || null;
}

function normalizeDigits(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\D/g, "");
  return normalized || null;
}

function titleCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
