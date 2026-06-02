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

/** Redact policy number patterns (e.g. POL-2024-001 or póliza NNNN-NNNN). */
const POLICY_PATTERN =
  /\b(?:POL|pol)-\d{4}-\d+\b|\bpóliza\s+[\dA-Za-z-]+/gi;

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
 * Only processes string values; leaves other types unchanged.
 */
export function redactObject(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = redactString(value);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Type alias for objects that can be safely passed to audit_log.payload.
 * The caller is responsible for not including PII fields.
 */
export type AuditPayload = Record<string, unknown>;
