/**
 * Unit tests for CSV safe-encoding utilities.
 *
 * AC13: Formula-injection guard — values starting with =, +, -, @ are
 *       prefixed with a single quote.
 */

import { describe, it, expect } from "vitest";
import { safeCsvCell, buildCsvRow, buildCsv } from "@/lib/csv/safe-encode";

// ── safeCsvCell — formula injection guard ─────────────────────────────────────

describe("safeCsvCell — formula injection guard", () => {
  const formulaChars = ["=", "+", "-", "@"];

  for (const char of formulaChars) {
    it(`prefixes '${char}...' with a single quote`, () => {
      const value = `${char}CMD|' /C calc'!A0`;
      const result = safeCsvCell(value);
      // The result must contain the injection-guard prefix (single quote before the trigger char).
      // The cell may also be wrapped in double-quotes due to the internal single-quote.
      expect(result).toContain(`'${char}`);
    });

    it(`cell starting with '${char}' is not executable — guard prefix is present`, () => {
      // Use a simple value without characters that trigger RFC 4180 quoting,
      // so the result is a plain string starting with the guard quote.
      const result = safeCsvCell(`${char}sum`);
      // Result must start with the injection-guard single quote.
      expect(result[0]).toBe("'");
    });
  }

  it("does not modify safe strings", () => {
    expect(safeCsvCell("Lucía Ramallo")).toBe("Lucía Ramallo");
    expect(safeCsvCell("12345")).toBe("12345");
    expect(safeCsvCell("Buenos Aires")).toBe("Buenos Aires");
  });

  it("handles empty string", () => {
    expect(safeCsvCell("")).toBe("");
  });

  it("handles null", () => {
    expect(safeCsvCell(null)).toBe("");
  });

  it("handles undefined", () => {
    expect(safeCsvCell(undefined)).toBe("");
  });

  it("handles numbers", () => {
    expect(safeCsvCell(42)).toBe("42");
    expect(safeCsvCell(0)).toBe("0");
    expect(safeCsvCell(3.14)).toBe("3.14");
  });

  it("wraps in double-quotes when value contains a comma", () => {
    const result = safeCsvCell("Ramallo, Lucía");
    expect(result).toBe('"Ramallo, Lucía"');
  });

  it("wraps in double-quotes and escapes internal quotes", () => {
    const result = safeCsvCell('value with "quotes"');
    expect(result).toBe('"value with ""quotes"""');
  });

  it("wraps in double-quotes when value contains newline", () => {
    const result = safeCsvCell("line1\nline2");
    expect(result).toContain('"');
  });

  it("formula + comma: both guards applied", () => {
    // The value starts with = and also contains a comma.
    // After injection guard it becomes '=val,ue — which then needs quoting.
    const result = safeCsvCell("=val,ue");
    expect(result.startsWith('"')).toBe(true);  // quoted due to comma in guarded string
    expect(result).toContain("'=val");           // injection prefix present
  });
});

// ── buildCsvRow ───────────────────────────────────────────────────────────────

describe("buildCsvRow", () => {
  it("joins cells with commas", () => {
    expect(buildCsvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  it("applies formula injection guard to all cells", () => {
    const result = buildCsvRow(["safe", "=HYPERLINK()", "+malicious"]);
    expect(result).toBe("safe,'=HYPERLINK(),'"+"+malicious");
  });

  it("handles mixed types", () => {
    const result = buildCsvRow(["name", null, 42, undefined, "end"]);
    expect(result).toBe("name,,42,,end");
  });
});

// ── buildCsv ──────────────────────────────────────────────────────────────────

describe("buildCsv", () => {
  it("returns header + data rows joined with CRLF", () => {
    const headers = ["Col A", "Col B"];
    const rows = [
      ["val1", "val2"],
      ["val3", "val4"],
    ];
    const result = buildCsv(headers, rows);
    const lines = result.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Col A,Col B");
    expect(lines[1]).toBe("val1,val2");
    expect(lines[2]).toBe("val3,val4");
  });

  it("returns only the header row when no data rows", () => {
    const result = buildCsv(["A", "B"], []);
    expect(result).toBe("A,B");
  });

  it("formula injection guard is applied to data values", () => {
    const headers = ["Name", "Formula"];
    const rows = [["Alice", "=DANGEROUS()"]];
    const result = buildCsv(headers, rows);
    expect(result).toContain("'=DANGEROUS()");
  });

  it("produces correct line count (1 header + N data rows)", () => {
    const headers = ["id", "status"];
    const rows = Array.from({ length: 25 }, (_, i) => [`case-${i}`, "listo"]);
    const result = buildCsv(headers, rows);
    const lines = result.split("\r\n");
    // 1 header + 25 data rows = 26 lines
    expect(lines).toHaveLength(26);
  });
});
