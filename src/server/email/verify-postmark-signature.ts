/**
 * HMAC-SHA256 signature verification for Postmark inbound webhooks.
 *
 * Postmark sends an HMAC-SHA256 signature in the X-Postmark-Signature header,
 * computed over the raw request body using the webhook secret configured in
 * the Postmark inbound server settings.
 *
 * Security notes:
 *   - The raw body MUST be read as a Buffer before any parsing. HMAC fails
 *     if the body is normalized (e.g. JSON.stringify(JSON.parse(body)) may
 *     change whitespace or key ordering).
 *   - crypto.timingSafeEqual is used for comparison — prevents timing attacks
 *     where an attacker could measure how many bytes matched.
 *   - If POSTMARK_WEBHOOK_SECRET is not configured, we fail closed (throw).
 *
 * AC2: Invalid or missing signature returns false — route handler returns 401.
 */

import * as crypto from "crypto";

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify the Postmark inbound webhook HMAC-SHA256 signature.
 *
 * @param rawBody     - The raw request body as a Buffer (MUST be raw — do not parse first)
 * @param signatureHeader - Value of the X-Postmark-Signature request header
 * @returns { valid: boolean; reason?: string }
 * @throws  Error if POSTMARK_WEBHOOK_SECRET is not set (fail-safe configuration error)
 */
export function verifyPostmarkSignature(
  rawBody: Buffer,
  signatureHeader: string | null | undefined
): VerifyResult {
  const secret = process.env.POSTMARK_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error(
      "[verify-postmark-signature] POSTMARK_WEBHOOK_SECRET is not set. " +
        "Configure this env var in Vercel and locally in .env.local."
    );
  }

  if (!signatureHeader || signatureHeader.trim() === "") {
    return { valid: false, reason: "missing_signature_header" };
  }

  // Compute expected HMAC-SHA256 over the raw body using the webhook secret.
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Decode the provided signature from hex.
  // If it's not valid hex or a different length, timingSafeEqual would throw —
  // catch and return invalid.
  let actual: Buffer;
  try {
    actual = Buffer.from(signatureHeader.trim(), "hex");
  } catch {
    return { valid: false, reason: "invalid_signature_encoding" };
  }

  const expectedBuf = Buffer.from(expected, "hex");

  // Lengths must match for timingSafeEqual — different lengths reveal nothing
  // about the HMAC content but we still want to avoid the RangeError it would throw.
  if (actual.length !== expectedBuf.length) {
    return { valid: false, reason: "signature_length_mismatch" };
  }

  // Constant-time comparison — prevents timing oracle attacks.
  const match = crypto.timingSafeEqual(actual, expectedBuf);
  if (!match) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}
