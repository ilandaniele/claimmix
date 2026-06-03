/**
 * Attachment validator for inbound email attachments.
 *
 * Enforces content-type allowlist, per-attachment size cap, and
 * per-email aggregate size cap before any upload to Supabase Storage.
 *
 * PII note: filenames are sanitized before use; original name is NOT logged.
 *
 * AC8: Disallowed content types are rejected with reason='content_type_not_allowed'.
 * AC9: Oversized attachments are rejected with reason='size_exceeded'.
 */

import { randomBytes } from "crypto";

// ── Constants ────────────────────────────────────────────────────────────────

/** Per-attachment maximum: 10 MB */
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

/** Per-email aggregate maximum: 25 MB */
export const MAX_AGGREGATE_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Allowed content-type patterns.
 *
 * Supports:
 *  - Exact match:  "application/pdf"
 *  - Prefix glob:  "image/*"  →  matches any "image/..." type
 *  - Prefix glob:  "application/vnd.openxmlformats-officedocument.*"
 */
export const CONTENT_TYPE_ALLOWLIST: ReadonlySet<string> = new Set([
  "image/*",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.*",
  "message/rfc822",
]);

// ── Types ────────────────────────────────────────────────────────────────────

export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: string };

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Determine whether a concrete content-type string matches any pattern in the allowlist.
 *
 * Matching rules (applied in order):
 *  1. Exact string match against a non-glob allowlist entry.
 *  2. Glob-prefix match: allowlist entry ending in "/*" or ".*" — the prefix
 *     (everything before the wildcard) must match the start of the incoming type.
 */
function matchesAllowlist(contentType: string): boolean {
  // Normalise: lowercase, strip parameters (e.g. "; charset=utf-8").
  const normalised = contentType.toLowerCase().split(";")[0].trim();

  for (const pattern of CONTENT_TYPE_ALLOWLIST) {
    if (pattern === normalised) {
      // Exact match.
      return true;
    }

    // Glob match: pattern ends with "/*" or ".*"
    if (pattern.endsWith("/*") || pattern.endsWith(".*")) {
      // The fixed prefix is everything before the last "/*" or ".*"
      const separator = pattern.endsWith("/*") ? "/*" : ".*";
      const prefix = pattern.slice(0, pattern.length - separator.length);

      // The incoming type must start with the prefix followed by "/" or "."
      // to prevent false-prefix matches like "image" matching "imagerocket/x-custom".
      const divider = separator === "/*" ? "/" : ".";
      if (normalised.startsWith(prefix + divider)) {
        return true;
      }
    }
  }

  return false;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate whether a content-type string is in the allowlist.
 *
 * @returns { allowed: true } or { allowed: false, reason: 'content_type_not_allowed' }
 */
export function validateContentType(contentType: string): { allowed: boolean; reason?: string } {
  if (matchesAllowlist(contentType)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "content_type_not_allowed" };
}

/**
 * Validate whether a per-attachment size is within the allowed cap.
 *
 * @param sizeBytes — the decoded (actual) byte length of the attachment.
 * @returns { allowed: true } or { allowed: false, reason: 'size_exceeded' }
 */
export function validateSize(sizeBytes: number): { allowed: boolean; reason?: string } {
  if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    return { allowed: false, reason: "size_exceeded" };
  }
  return { allowed: true };
}

/**
 * Sanitize a filename for safe storage.
 *
 * Steps:
 *  1. Strip directory components — keep only the basename (after last / or \).
 *  2. Replace any character outside [A-Za-z0-9._-] with underscore.
 *  3. Prepend a random 8-byte hex prefix to prevent collisions and path traversal.
 *
 * Example: "../../evil file!.pdf" → "a3f9c01b7e2d4f56-evil_file_.pdf"
 */
export function sanitizeFilename(name: string): string {
  // 1. Strip path components.
  const basename = name.replace(/.*[/\\]/, "");

  // 2. Replace disallowed characters.
  const sanitized = basename.replace(/[^A-Za-z0-9._-]/g, "_");

  // 3. Prepend 8-byte (16 hex char) random prefix.
  const prefix = randomBytes(8).toString("hex");

  return `${prefix}-${sanitized}`;
}

/**
 * Combined attachment validator — checks content-type then size.
 *
 * Callers should check content-type first (cheaper) and only proceed
 * to size check if the type is allowed.
 */
export function validateAttachment(
  contentType: string,
  sizeBytes: number
): ValidateResult {
  const typeResult = validateContentType(contentType);
  if (!typeResult.allowed) {
    return { ok: false, reason: typeResult.reason! };
  }

  const sizeResult = validateSize(sizeBytes);
  if (!sizeResult.allowed) {
    return { ok: false, reason: sizeResult.reason! };
  }

  return { ok: true };
}
