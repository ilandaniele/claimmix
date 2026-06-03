/**
 * Unit tests for src/server/email/attachment-validator.ts
 *
 * Covers:
 *   - validateContentType: allowlist members (✓), rejected types (✗)
 *   - validateSize: boundary conditions around MAX_ATTACHMENT_SIZE_BYTES
 *   - validateAttachment: combined validator
 *   - sanitizeFilename: path traversal, special characters, prefix
 *
 * AC8: Disallowed types rejected with reason='content_type_not_allowed'
 * AC9: Oversize rejected with reason='size_exceeded'
 */

import { describe, it, expect } from "vitest";
import {
  validateContentType,
  validateSize,
  validateAttachment,
  sanitizeFilename,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_AGGREGATE_SIZE_BYTES,
} from "@/server/email/attachment-validator";

// ── validateContentType ───────────────────────────────────────────────────────

describe("validateContentType", () => {
  // Allowed types from allowlist
  it("allows application/pdf", () => {
    expect(validateContentType("application/pdf")).toEqual({ allowed: true });
  });

  it("allows text/plain", () => {
    expect(validateContentType("text/plain")).toEqual({ allowed: true });
  });

  it("allows application/msword", () => {
    expect(validateContentType("application/msword")).toEqual({ allowed: true });
  });

  it("allows message/rfc822", () => {
    expect(validateContentType("message/rfc822")).toEqual({ allowed: true });
  });

  // image/* glob matching
  it("allows image/jpeg (image/* glob)", () => {
    expect(validateContentType("image/jpeg")).toEqual({ allowed: true });
  });

  it("allows image/png (image/* glob)", () => {
    expect(validateContentType("image/png")).toEqual({ allowed: true });
  });

  it("allows image/gif (image/* glob)", () => {
    expect(validateContentType("image/gif")).toEqual({ allowed: true });
  });

  it("allows image/webp (image/* glob)", () => {
    expect(validateContentType("image/webp")).toEqual({ allowed: true });
  });

  // vnd.openxmlformats-officedocument.* glob matching
  it("allows application/vnd.openxmlformats-officedocument.wordprocessingml.document (.docx)", () => {
    expect(
      validateContentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toEqual({ allowed: true });
  });

  it("allows application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (.xlsx)", () => {
    expect(
      validateContentType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
    ).toEqual({ allowed: true });
  });

  it("allows application/vnd.openxmlformats-officedocument.presentationml.presentation (.pptx)", () => {
    expect(
      validateContentType(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      )
    ).toEqual({ allowed: true });
  });

  // Content-type with parameters — should strip and still match
  it("allows text/plain with charset parameter", () => {
    expect(validateContentType("text/plain; charset=utf-8")).toEqual({ allowed: true });
  });

  it("allows application/pdf with parameters", () => {
    expect(validateContentType("application/pdf; name=doc.pdf")).toEqual({ allowed: true });
  });

  // Case-insensitivity
  it("allows APPLICATION/PDF (uppercase — normalised)", () => {
    expect(validateContentType("APPLICATION/PDF")).toEqual({ allowed: true });
  });

  // Rejected types (AC8)
  it("rejects application/x-msdownload (executable)", () => {
    const result = validateContentType("application/x-msdownload");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("content_type_not_allowed");
  });

  it("rejects application/x-executable", () => {
    const result = validateContentType("application/x-executable");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("content_type_not_allowed");
  });

  it("rejects application/javascript", () => {
    const result = validateContentType("application/javascript");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("content_type_not_allowed");
  });

  it("rejects text/html", () => {
    const result = validateContentType("text/html");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("content_type_not_allowed");
  });

  it("rejects application/zip", () => {
    const result = validateContentType("application/zip");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("content_type_not_allowed");
  });

  it("rejects empty string", () => {
    const result = validateContentType("");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("content_type_not_allowed");
  });

  // Prefix-boundary safety: 'imagerocket/x-custom' must NOT match 'image/*'
  it("rejects imagerocket/x-custom (must not false-match image/* prefix)", () => {
    const result = validateContentType("imagerocket/x-custom");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("content_type_not_allowed");
  });
});

// ── validateSize ─────────────────────────────────────────────────────────────

describe("validateSize", () => {
  it("allows size = 0", () => {
    expect(validateSize(0)).toEqual({ allowed: true });
  });

  it("allows size exactly equal to MAX_ATTACHMENT_SIZE_BYTES (10 MB)", () => {
    expect(validateSize(MAX_ATTACHMENT_SIZE_BYTES)).toEqual({ allowed: true });
  });

  it("allows size 1 byte below the limit", () => {
    expect(validateSize(MAX_ATTACHMENT_SIZE_BYTES - 1)).toEqual({ allowed: true });
  });

  it("allows 500 KB", () => {
    expect(validateSize(500 * 1024)).toEqual({ allowed: true });
  });

  // AC9: oversize rejection
  it("rejects size 1 byte over the limit", () => {
    const result = validateSize(MAX_ATTACHMENT_SIZE_BYTES + 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("size_exceeded");
  });

  it("rejects 11 MB", () => {
    const result = validateSize(11 * 1024 * 1024);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("size_exceeded");
  });

  it("rejects 100 MB", () => {
    const result = validateSize(100 * 1024 * 1024);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("size_exceeded");
  });
});

// ── validateAttachment (combined) ─────────────────────────────────────────────

describe("validateAttachment", () => {
  const VALID_TYPE = "application/pdf";
  const VALID_SIZE = 500 * 1024; // 500 KB

  it("returns ok:true for valid type + valid size", () => {
    expect(validateAttachment(VALID_TYPE, VALID_SIZE)).toEqual({ ok: true });
  });

  it("returns ok:false with reason='content_type_not_allowed' for invalid type", () => {
    const result = validateAttachment("application/x-msdownload", VALID_SIZE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("content_type_not_allowed");
    }
  });

  it("returns ok:false with reason='size_exceeded' for valid type + oversize", () => {
    const result = validateAttachment(VALID_TYPE, 11 * 1024 * 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("size_exceeded");
    }
  });

  it("checks content-type before size (invalid type wins)", () => {
    // Even with oversize, content-type check fires first.
    const result = validateAttachment("application/x-msdownload", 11 * 1024 * 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("content_type_not_allowed");
    }
  });
});

// ── sanitizeFilename ──────────────────────────────────────────────────────────

describe("sanitizeFilename", () => {
  it("strips Unix path components", () => {
    const sanitized = sanitizeFilename("/etc/passwd");
    // Should only retain 'passwd' as the basename
    expect(sanitized).toMatch(/^[0-9a-f]{16}-passwd$/);
  });

  it("strips Windows path components", () => {
    const sanitized = sanitizeFilename("C:\\Users\\attacker\\evil.pdf");
    expect(sanitized).toMatch(/^[0-9a-f]{16}-evil\.pdf$/);
  });

  it("strips deep relative path traversal", () => {
    const sanitized = sanitizeFilename("../../etc/shadow");
    expect(sanitized).toMatch(/^[0-9a-f]{16}-shadow$/);
  });

  it("replaces spaces with underscores", () => {
    const sanitized = sanitizeFilename("my document.pdf");
    expect(sanitized).toMatch(/^[0-9a-f]{16}-my_document\.pdf$/);
  });

  it("replaces special characters with underscores", () => {
    const sanitized = sanitizeFilename("evil file!@#$.exe");
    // All chars outside [A-Za-z0-9._-] → '_'
    // "evil file!@#$.exe" → space→_, !→_, @→_, #→_, $→_  = "evil_file____"
    expect(sanitized).toMatch(/^[0-9a-f]{16}-evil_file____\.exe$/);
  });

  it("preserves allowed characters: letters, digits, dots, hyphens, underscores", () => {
    const sanitized = sanitizeFilename("valid_file-name.2024.pdf");
    expect(sanitized).toMatch(/^[0-9a-f]{16}-valid_file-name\.2024\.pdf$/);
  });

  it("prepends exactly 16 hex characters (8-byte prefix)", () => {
    const sanitized = sanitizeFilename("test.pdf");
    const prefix = sanitized.split("-")[0];
    expect(prefix).toHaveLength(16);
    expect(prefix).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces different prefixes on each call (random)", () => {
    const a = sanitizeFilename("test.pdf");
    const b = sanitizeFilename("test.pdf");
    // The 16-char hex prefix should differ (astronomically unlikely to collide).
    const prefixA = a.split("-")[0];
    const prefixB = b.split("-")[0];
    expect(prefixA).not.toBe(prefixB);
  });

  it("handles empty string as filename", () => {
    const sanitized = sanitizeFilename("");
    // prefix + '-' + empty sanitized = 'prefix-'
    expect(sanitized).toMatch(/^[0-9a-f]{16}-$/);
  });

  it("handles filename with only special characters", () => {
    const sanitized = sanitizeFilename("!!!");
    expect(sanitized).toMatch(/^[0-9a-f]{16}-___$/);
  });
});

// ── Constants exported correctly ───────────────────────────────────────────────

describe("exported constants", () => {
  it("MAX_ATTACHMENT_SIZE_BYTES equals 10 MB", () => {
    expect(MAX_ATTACHMENT_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("MAX_AGGREGATE_SIZE_BYTES equals 25 MB", () => {
    expect(MAX_AGGREGATE_SIZE_BYTES).toBe(25 * 1024 * 1024);
  });
});
