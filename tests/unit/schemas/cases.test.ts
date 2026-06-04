/**
 * AC16: ClaimTypeSchema parses "other"; TypeScript union includes "other".
 *
 * Extends the root-level schemas-cases.test.ts with targeted checks for the
 * newly-added "other" claim type value.
 */

import { describe, it, expect } from "vitest";
import { ClaimTypeSchema } from "@/lib/schemas/cases";
import type { ClaimType } from "@/lib/schemas/cases";

describe("ClaimTypeSchema — AC16 (other value)", () => {
  it('parses "other" successfully', () => {
    const result = ClaimTypeSchema.safeParse("other");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("other");
    }
  });

  it('still parses existing value "choque"', () => {
    const result = ClaimTypeSchema.safeParse("choque");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("choque");
    }
  });

  it("still parses all original claim types", () => {
    const originals = ["choque", "robo", "granizo", "incendio"] as const;
    for (const type of originals) {
      expect(ClaimTypeSchema.safeParse(type).success, `expected ${type} to parse`).toBe(true);
    }
  });

  it('rejects a value not in the union (e.g. "inundacion")', () => {
    expect(ClaimTypeSchema.safeParse("inundacion").success).toBe(false);
  });

  it("TypeScript union includes 'other' at compile time", () => {
    // This test verifies the TypeScript type is correct by assigning "other"
    // to ClaimType. If "other" were missing from the enum, this would be a
    // compile-time error that `pnpm type-check` would catch.
    const value: ClaimType = "other";
    expect(value).toBe("other");
  });
});
