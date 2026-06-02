/**
 * CSV safe-encoding utilities for ClaimMix.
 *
 * AC13: Formula-injection guard — values that start with =, +, -, @ are
 * prefixed with a single quote (') so spreadsheet applications (Excel,
 * Google Sheets, LibreOffice) treat them as text, not formulas.
 *
 * References:
 * - OWASP CSV Injection: https://owasp.org/www-community/attacks/CSV_Injection
 * - Microsoft Excel formula injection mitigation.
 *
 * The output is UTF-8 CSV with comma delimiter and CRLF line endings
 * (RFC 4180 compliant).
 */

/** Characters that trigger formula evaluation in spreadsheet applications. */
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@"]);

/**
 * Sanitize a single CSV cell value to prevent formula injection.
 *
 * Rules:
 * 1. If the value starts with a formula trigger character, prefix with `'`.
 * 2. Wrap the value in double-quotes if it contains commas, double-quotes,
 *    newlines, or carriage returns (RFC 4180).
 * 3. Escape any internal double-quotes by doubling them ("").
 * 4. Null / undefined values become an empty string.
 */
export function safeCsvCell(value: string | number | null | undefined): string {
  // Normalize to string
  const str = value === null || value === undefined ? "" : String(value);

  // Apply formula-injection guard: prefix dangerous first character with '
  let safe = str;
  if (safe.length > 0 && FORMULA_TRIGGER_CHARS.has(safe[0])) {
    safe = "'" + safe;
  }

  // RFC 4180: wrap in quotes if the value contains comma, double-quote, CR, or LF
  const needsQuoting = safe.includes(",") || safe.includes('"') || safe.includes("\r") || safe.includes("\n");
  if (needsQuoting) {
    // Escape internal double-quotes by doubling them
    safe = '"' + safe.replace(/"/g, '""') + '"';
  }

  return safe;
}

/**
 * Build a CSV row string from an array of cell values.
 * Uses comma delimiter and CRLF line ending (RFC 4180).
 */
export function buildCsvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(safeCsvCell).join(",");
}

/**
 * Build a complete CSV string from a header row and data rows.
 * Returns a UTF-8 string with CRLF line endings (RFC 4180).
 *
 * @param headers - Column header labels.
 * @param rows    - Array of row arrays; each inner array must match headers.length.
 * @returns Complete CSV string ready to stream as a response body.
 */
export function buildCsv(
  headers: string[],
  rows: (string | number | null | undefined)[][]
): string {
  const lines: string[] = [];
  lines.push(buildCsvRow(headers));
  for (const row of rows) {
    lines.push(buildCsvRow(row));
  }
  // RFC 4180: CRLF line endings
  return lines.join("\r\n");
}
