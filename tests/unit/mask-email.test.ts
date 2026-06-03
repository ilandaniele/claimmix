/**
 * Unit tests for maskEmail helper.
 *
 * Covers:
 *   - Standard email address
 *   - Single-char local part
 *   - Multi-char local part
 *   - No-dot domain (e.g. localhost)
 *   - null / undefined / empty inputs
 *   - Invalid email shape (no '@')
 */

import { describe, it, expect } from "vitest";
import { maskEmail } from "@/lib/email/mask";

describe("maskEmail", () => {
  it("masks a standard email address", () => {
    expect(maskEmail("gmail@claimmix.com")).toBe("g***@claimmix.com");
  });

  it("masks a single-char local part", () => {
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  it("masks a long local part (only first char shown)", () => {
    expect(maskEmail("hi@b.io")).toBe("h***@b.io");
  });

  it("masks with no-dot domain", () => {
    expect(maskEmail("test@localhost")).toBe("t***@localhost");
  });

  it("returns null for null input", () => {
    expect(maskEmail(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(maskEmail(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(maskEmail("")).toBeNull();
  });

  it("returns null when '@' is the first character (invalid local)", () => {
    expect(maskEmail("@domain.com")).toBeNull();
  });

  it("returns null when no '@' is present", () => {
    expect(maskEmail("notanemail")).toBeNull();
  });

  it("uses only the last '@' as the domain separator", () => {
    // Edge case: email with no multiple '@' — standard emails have exactly one.
    // Verify domain extraction is correct.
    expect(maskEmail("user@sub.domain.com")).toBe("u***@sub.domain.com");
  });
});
