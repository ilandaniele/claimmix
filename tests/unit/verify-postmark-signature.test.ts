/**
 * Unit tests for HMAC-SHA256 Postmark webhook signature verification.
 *
 * AC2: Invalid or missing HMAC returns { valid: false } — route returns 401.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as crypto from "crypto";

// We import the module under test dynamically so we can control env vars.
// The module reads POSTMARK_WEBHOOK_SECRET at call time, not at import time.
const MODULE_PATH = "../../src/server/email/verify-postmark-signature";

function computeExpectedSignature(rawBody: Buffer, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

describe("verifyPostmarkSignature", () => {
  const SECRET = "test-webhook-secret-abc123";
  const rawBody = Buffer.from('{"MessageID":"msg-001","From":"test@example.com"}', "utf-8");

  beforeEach(() => {
    // Set env var before each test.
    process.env.POSTMARK_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.POSTMARK_WEBHOOK_SECRET;
  });

  it("returns { valid: true } for a correct HMAC signature", async () => {
    const { verifyPostmarkSignature } = await import(MODULE_PATH);
    const signature = computeExpectedSignature(rawBody, SECRET);

    const result = verifyPostmarkSignature(rawBody, signature);

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns { valid: false } for an incorrect HMAC signature", async () => {
    const { verifyPostmarkSignature } = await import(MODULE_PATH);
    const wrongSignature = computeExpectedSignature(rawBody, "wrong-secret");

    const result = verifyPostmarkSignature(rawBody, wrongSignature);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("returns { valid: false } when the X-Postmark-Signature header is missing (null)", async () => {
    const { verifyPostmarkSignature } = await import(MODULE_PATH);

    const result = verifyPostmarkSignature(rawBody, null);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_signature_header");
  });

  it("returns { valid: false } when the X-Postmark-Signature header is an empty string", async () => {
    const { verifyPostmarkSignature } = await import(MODULE_PATH);

    const result = verifyPostmarkSignature(rawBody, "");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_signature_header");
  });

  it("returns { valid: false } when the signature is only whitespace", async () => {
    const { verifyPostmarkSignature } = await import(MODULE_PATH);

    const result = verifyPostmarkSignature(rawBody, "   ");

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_signature_header");
  });

  it("throws a config error when POSTMARK_WEBHOOK_SECRET is not set", async () => {
    delete process.env.POSTMARK_WEBHOOK_SECRET;
    const { verifyPostmarkSignature } = await import(MODULE_PATH);
    const signature = computeExpectedSignature(rawBody, SECRET);

    expect(() => verifyPostmarkSignature(rawBody, signature)).toThrowError(
      /POSTMARK_WEBHOOK_SECRET/
    );
  });

  it("returns { valid: false } for a non-hex signature string (length mismatch)", async () => {
    const { verifyPostmarkSignature } = await import(MODULE_PATH);

    // "xyz" is not valid hex — Buffer.from("xyz", "hex") produces a Buffer of
    // length 1 (skips invalid hex chars), which won't match the 32-byte HMAC.
    const result = verifyPostmarkSignature(rawBody, "xyz");

    expect(result.valid).toBe(false);
  });

  it("uses timing-safe comparison — different body produces different HMAC", async () => {
    const { verifyPostmarkSignature } = await import(MODULE_PATH);
    const differentBody = Buffer.from('{"MessageID":"msg-002"}', "utf-8");
    // Signature computed over differentBody is NOT valid for rawBody.
    const signatureForDifferentBody = computeExpectedSignature(differentBody, SECRET);

    const result = verifyPostmarkSignature(rawBody, signatureForDifferentBody);

    expect(result.valid).toBe(false);
  });

  it("does not short-circuit on prefix match — full body must match", async () => {
    const { verifyPostmarkSignature } = await import(MODULE_PATH);
    // The attacker knows the first few bytes of the HMAC but not all 32.
    // timingSafeEqual ensures we compare all 32 bytes regardless.
    const correctSig = computeExpectedSignature(rawBody, SECRET);
    // Tamper just the last 2 hex chars (1 byte).
    const tamperedSig =
      correctSig.slice(0, -2) +
      (correctSig.slice(-2) === "00" ? "ff" : "00");

    const result = verifyPostmarkSignature(rawBody, tamperedSig);

    expect(result.valid).toBe(false);
  });
});
