/**
 * Attachment validator for inbound email attachments.
 *
 * Enforces content-type allowlist, per-attachment size cap, and
 * per-email aggregate size cap before any upload to object storage.
 *
 * PII note: filenames are sanitized before use; original name is NOT logged.
 *
 * AC8: Disallowed content types are rejected with reason='content_type_not_allowed'.
 * AC9: Oversized attachments are rejected with reason='size_exceeded'.
 */

import { randomBytes } from "crypto";
import { AUDIO_PERMITIDO, MAX_ATTACHMENT_SIZE_BYTES, normalizarMime } from "@/core/adjuntos/firma";

// ── Constants ────────────────────────────────────────────────────────────────

export { MAX_ATTACHMENT_SIZE_BYTES };

/**
 * Largo máximo del nombre saneado, sin el prefijo aleatorio.
 *
 * La clave en R2 es tenant/caso/mensaje/prefijo-nombre y admite 1024 bytes: con
 * tres UUID y el prefijo quedan unos 750, y el nombre lo elige el remitente. El
 * saneado deja sólo ASCII, así que un carácter es un byte.
 */
const MAX_FILENAME_LENGTH = 120;

/** Una extensión más larga que esto no es una extensión: se corta como el resto. */
const MAX_EXTENSION_LENGTH = 16;

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
  // Las notas de voz, con nombre exacto: nada de `audio/*`.
  ...AUDIO_PERMITIDO,
]);

/**
 * Lo que NO entra, aunque la lista blanca lo deje pasar por un glob.
 *
 * `image/*` está para las fotos del siniestro, y un SVG cae ahí adentro sin
 * ser una foto: es XML, y el XML puede traer `<script>` y `onload`. Abierto en
 * una pestaña desde nuestro dominio, eso es XSS almacenado con la sesión del
 * analista.
 *
 * Hoy el riesgo está acotado porque los adjuntos no se sirven desde la
 * aplicación —`external_url` no lo escribe nadie—, pero eso es una propiedad
 * de hoy, no una defensa. La defensa es no aceptarlos: nadie denuncia un choque
 * mandando un SVG.
 *
 * Se comprueba ANTES que la lista blanca, así que un glob nuevo tampoco los
 * puede volver a colar.
 */
export const CONTENT_TYPE_DENYLIST: ReadonlySet<string> = new Set([
  "image/svg+xml",
  "image/svg",
  // XML a secas por lo mismo: entidades externas y hojas de estilo remotas.
  "image/xml",
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
  const normalised = normalizarMime(contentType);

  // La lista negra manda: está para los que un glob de la blanca dejaría pasar.
  if (CONTENT_TYPE_DENYLIST.has(normalised)) return false;

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
 *  3. Cap the length at MAX_FILENAME_LENGTH, keeping the extension.
 *  4. Prepend a random 8-byte hex prefix to prevent collisions and path traversal.
 *
 * Example: "../../evil file!.pdf" → "a3f9c01b7e2d4f56-evil_file_.pdf"
 */
export function sanitizeFilename(name: string): string {
  // 1. Strip path components.
  const basename = name.replace(/.*[/\\]/, "");

  // 2. Replace disallowed characters.
  const sanitized = basename.replace(/[^A-Za-z0-9._-]/g, "_");

  // 3. Acotar el largo sin perder la extensión.
  let acotado = sanitized;
  if (sanitized.length > MAX_FILENAME_LENGTH) {
    const punto = sanitized.lastIndexOf(".");
    const extension =
      punto > 0 && sanitized.length - punto <= MAX_EXTENSION_LENGTH ? sanitized.slice(punto) : "";
    acotado = sanitized.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
  }

  // 4. Prepend 8-byte (16 hex char) random prefix.
  const prefix = randomBytes(8).toString("hex");

  return `${prefix}-${acotado}`;
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
