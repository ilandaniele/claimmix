import type { ExtractedField } from "@/lib/schemas/extracted-claim";

type ParseInput = {
  subject?: string | null;
  body?: string | null;
  senderEmail?: string | null;
};

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const LABELED_EMAIL_RE = /\bEmail\s*:\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i;
const DNI_RE = /\b(?:DU|DNI)\s*(?:Nro\.?|N[ro]*\.?|No\.?)?\s*:?\s*([0-9.]{7,12})(?=\D|$)/i;
const LABELED_DNI_RE = /\bDNI\s*:\s*([0-9.]{7,12})(?=\D|$)/i;
const CBU_RE = /\bCBU\s*(?:Nro\.?|N[ro]*\.?|No\.?)?\s*:?\s*([0-9]{18,24})(?=\D|$)/i;
const CLAIM_REF_RE = /\bSiniestro\s+([A-Z0-9][A-Z0-9-]{4,})\b/i;
const POLICY_NUMBER_RE = /\b(?:N[uú]mero\s+de\s+p[oó]liza|P[oó]liza)\s*:\s*([A-Z0-9][A-Z0-9-]{4,})\b/i;
const ACCIDENT_DATE_RE = /\bAccidente\s+del\s+(\d{1,2}\/\d{1,2}\/\d{4})\b/i;
const INCIDENT_DATE_RE = /\b(?:ocurrido\s+el\s+d[ií]a|d[ií]a)\s+(\d{1,2}(?:\s+de\s+[a-záéíóúñ]+(?:\s+de)?\s+\d{4}|\/\d{1,2}\/\d{4}))\b/i;
const DATE_RE = /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/;
const FULL_NAME_RE = /\bNombre\s+completo\s*:\s*(.+?)(?=\s+-\s*(?:DNI|Tel[eé]fono|Email|N[uú]mero\s+de\s+p[oó]liza)\b|\s+Descripci[oó]n\b|$)/i;
const PHONE_RE = /\bTel[eé]fono\s*:\s*([+()0-9][+()0-9\s.-]{6,40})/i;
const LOCATION_RE = /\ben\s+la\s+intersecci[oó]n\s+de\s+(.+?)(?:\.|El\s+otro|Hubo\s+da[ñn]os|Tipo\s+de\s+siniestro|Documentaci[oó]n|$)/i;
const PLATE_PATTERN_SOURCE = "[A-Z]{2}\\s?\\d{3}\\s?[A-Z]{2}|[A-Z]{3}\\s?\\d{3}";
const PLATE_RE = new RegExp(`\\b(?:dominio|patente)\\s+(${PLATE_PATTERN_SOURCE})(?=\\W|$)`, "gi");
const VEHICLE_RE = new RegExp(`\\b(?:mi\\s+veh[ií]culo|un)\\s+\\(([^()]*?)\\s*,?\\s*patente\\s+${PLATE_PATTERN_SOURCE}\\)`, "gi");
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
  accident_location: 0.84,
  claim_type: 0.86,
  party_a_plate: 0.9,
  party_b_plate: 0.9,
  party_a_vehicle: 0.82,
  party_b_vehicle: 0.82,
  insurer: 0.82,
  phone: 0.9,
  fotos_danos: 0.9,
  licencia_conducir: 0.9,
  denuncia_policial: 0.9,
  police_report_number: 0.9,
};

export function parseEmailClaimFields(input: ParseInput): ExtractedField[] {
  const subject = cleanText(input.subject ?? "");
  const body = cleanText(input.body ?? "");
  const text = `${subject}\n${body}`;
  const fields: ExtractedField[] = [];

  addField(fields, "full_name", extractFullName(text));
  addField(fields, "email", extractEmail(text, input.senderEmail));
  addField(fields, "phone", matchValue(PHONE_RE, text));
  addField(fields, "dni", normalizeDni(matchValue(DNI_RE, text) ?? matchValue(LABELED_DNI_RE, text)));
  addField(fields, "cbu", normalizeDigits(matchValue(CBU_RE, text)));
  addField(fields, "policy_number", matchValue(POLICY_NUMBER_RE, text) ?? matchValue(CLAIM_REF_RE, subject) ?? matchValue(CLAIM_REF_RE, text));
  addField(fields, "accident_date", matchValue(ACCIDENT_DATE_RE, subject) ?? matchValue(DATE_RE, subject) ?? normalizeIncidentDate(matchValue(INCIDENT_DATE_RE, text)) ?? matchValue(DATE_RE, text));
  addField(fields, "accident_location", extractAccidentLocation(text));
  addField(fields, "claim_type", inferClaimType(text));
  addField(fields, "insurer", extractInsurer(subject));
  addField(fields, "accident_description", extractAccidentDescription(subject) ?? extractBodyDescription(text));
  addDocumentationFields(fields, text);

  const plates = [...text.matchAll(PLATE_RE)].map((m) => normalizePlate(m[1] ?? ""));
  if (plates[0]) addField(fields, "party_a_plate", plates[0]);
  if (plates[1]) addField(fields, "party_b_plate", plates[1]);

  const vehicles = extractVehicles(text);
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
  const labeledName = matchValue(FULL_NAME_RE, text);
  if (labeledName) return titleCase(labeledName);

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
  const labeled = matchValue(LABELED_EMAIL_RE, text);
  if (labeled) return labeled;

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

function extractBodyDescription(text: string): string | null {
  const match = /Descripci[oó]n del siniestro\s*:\s*(.+?)(?:Tipo de siniestro|Documentaci[oó]n adjunta|Documentaci[oó]n pendiente|Quedo a disposici[oó]n|Saludos,|$)/i.exec(text);
  return match?.[1]?.trim() ?? null;
}

function extractAccidentLocation(text: string): string | null {
  const value = matchValue(LOCATION_RE, text);
  return value?.replace(/\s+/g, " ").trim() ?? null;
}

function extractVehicles(subject: string): string[] {
  const platePattern = new RegExp(PLATE_PATTERN_SOURCE, "i");
  const fromSubjectFirst = new RegExp(`entre\\s+(.+?)\\s+dominio\\s+${platePattern.source}`, "i").exec(subject)?.[1];
  const fromSubjectSecond = new RegExp(`\\sy\\s+(.+?)\\s+dominio\\s+${platePattern.source}`, "i").exec(subject)?.[1];
  const fromBody = [...subject.matchAll(VEHICLE_RE)].map((match) => match[1]);
  return [fromSubjectFirst, fromSubjectSecond, ...fromBody]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim());
}

function addDocumentationFields(fields: ExtractedField[], text: string): void {
  const folded = fold(text);
  if (/fotos?\s+del\s+vehiculo\s+danado|fotos?\s+de\s+(?:los\s+)?danos|fotos?\s+del\s+da[nñ]o/.test(folded)) {
    addField(fields, "fotos_danos", "si");
  }
  if (/licencia\s+de\s+conducir/.test(folded)) {
    addField(fields, "licencia_conducir", "si");
  }
  if (/denuncia\s+policial/.test(folded)) {
    addField(fields, "denuncia_policial", "si");
    const report = /\bDenuncia policial\s+Nro\.?\s*([A-Z0-9/-]+)/i.exec(text)?.[1];
    addField(fields, "police_report_number", report);
  }
}

function normalizeIncidentDate(value: string | null): string | null {
  if (!value) return null;
  const slashDate = DATE_RE.exec(value)?.[1];
  if (slashDate) return slashDate;

  const match = /(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de)?\s+(\d{4})/i.exec(value);
  if (!match) return value;

  const months: Record<string, string> = {
    enero: "01",
    febrero: "02",
    marzo: "03",
    abril: "04",
    mayo: "05",
    junio: "06",
    julio: "07",
    agosto: "08",
    septiembre: "09",
    setiembre: "09",
    octubre: "10",
    noviembre: "11",
    diciembre: "12",
  };
  const month = months[fold(match[2] ?? "")];
  if (!month) return value;
  return `${(match[1] ?? "").padStart(2, "0")}/${month}/${match[3]}`;
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
    .replace(/(^|[\s.'-])(\p{L})/gu, (_match, prefix: string, char: string) => {
      return `${prefix}${char.toUpperCase()}`;
    });
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
