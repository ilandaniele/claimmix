/**
 * PII redaction utilities for ClaimMix.
 *
 * AC18: Logs must never contain DNI numbers or policy numbers.
 * These functions sanitize strings before they enter the audit_log or
 * any structured log output via pino.
 *
 * Patterns:
 *   - DNI: 1–3 digits, optional dot, 3 digits, optional dot, 3 digits
 *     e.g. "35.123.456" | "35123456" | "3.123.456"
 *   - Policy number: insurer-format prefix + digits
 *     e.g. "POL-2024-001" | "póliza 0000-9999"
 *
 * These are conservative patterns — they may over-match in edge cases,
 * which is acceptable (better to redact too much than too little in logs).
 */

/** Redact Argentine DNI patterns (1-3 digits, optional dots, 6-digit suffix). */
const DNI_PATTERN = /\b\d{1,3}\.?\d{3}\.?\d{3}\b/g;

/**
 * Redact policy number patterns (e.g. POL-2024-001 or póliza NNNN-NNNN).
 *
 * La segunda mitad exige que lo que sigue a «póliza» TENGA UN DÍGITO.
 *
 * Era `\bpóliza\s+[\dA-Za-z-]+`, o sea que se comía cualquier palabra que
 * viniera detrás. En prosa eso no es tachar de más: cambia el sentido. El caso
 * que lo destapó, palabra por palabra:
 *
 *   «sin la póliza no se puede abrir el expediente»
 *   → «sin la [POLIZA] se puede abrir el expediente»
 *
 * El «no» desapareció y la frase quedó diciendo lo contrario. Y eso vive en el
 * `audit_log`, que es donde una aseguradora va a buscar POR QUÉ el agente hizo
 * lo que hizo.
 *
 * Tachar de más un VALOR es la decisión declarada arriba y está bien. Borrarle
 * una palabra a una oración es otra cosa.
 */
const POLICY_PATTERN =
  /\b(?:POL|pol)-\d{4}-\d+\b|\bpóliza\s+(?=[\dA-Za-z-]*\d)[\dA-Za-z-]+/gi;

/** Redact full Argentine license plate patterns (e.g. ABC 123 or AB 123 CD). */
const PLATE_PATTERN = /\b[A-Z]{2,3}\s?\d{3}\s?[A-Z]{0,2}\b/g;

/**
 * Redact PII patterns from a string.
 * Replaces DNIs, policy numbers, and license plates with placeholders.
 */
export function redactString(input: string): string {
  return input
    .replace(DNI_PATTERN, "[DNI]")
    .replace(POLICY_PATTERN, "[POLIZA]")
    .replace(PLATE_PATTERN, "[PATENTE]");
}

/**
 * Recursively redact PII from an object for safe logging.
 * Returns a new object — does not mutate the original.
 *
 * ── Los arrays TAMBIÉN ──────────────────────────────────────────────────────
 *
 * Estaban excluidos con un `!Array.isArray(value)` explícito, o sea que todo lo
 * que viajara dentro de una lista salía crudo. Y eso es justo lo que pasa con
 * las consultas del agente: el payload de `agent.deliberated` lleva
 * `tools: [{ tool: "polizas_por_dni", args: { dni: "25.888.101" } }]`, así que
 * el documento entraba entero al `audit_log`, que es una tabla que se exporta,
 * se muestra y se le entrega a la aseguradora.
 *
 * Las CLAVES no se tocan, sólo los valores: `resolved: [{ field:
 * "policy_number", value: "[POLIZA]" }]` sigue diciendo QUÉ resolvió el agente,
 * que es la pregunta para la que existe esa entrada.
 */
export function redactObject(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = redactValue(value);
  }
  return result;
}

/** Un valor cualquiera, limpio: cadena, lista, objeto o lo que sea. */
function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Type alias for objects that can be safely passed to audit_log.payload.
 * The caller is responsible for not including PII fields.
 */
export type AuditPayload = Record<string, unknown>;
