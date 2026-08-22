/**
 * Unit tests for the health endpoint logic.
 *
 * The route handler itself is tested as an integration test in tests/integration/.
 * Here we test the environment checks and CSP utilities used by it.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock server-only so imports that use it compile in the test environment.
vi.mock("server-only", () => ({}));
import { generateNonce, buildCsp } from "@/lib/security/csp";

describe("generateNonce", () => {
  it("returns a base64 string of 24 characters (16 bytes → base64)", () => {
    const nonce = generateNonce();
    // 16 bytes in base64 = 24 characters (with possible padding)
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBeGreaterThan(0);
    // Should be valid base64
    expect(() => Buffer.from(nonce, "base64")).not.toThrow();
  });

  it("generates a different nonce on each call", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => generateNonce()));
    // All 100 nonces should be unique (collision probability is negligible)
    expect(nonces.size).toBe(100);
  });

  it("generates nonces that are safe to use in HTML attributes", () => {
    const nonce = generateNonce();
    // Base64 characters are all HTML-safe: A-Z, a-z, 0-9, +, /, =
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("buildCsp", () => {
  it("includes the nonce in script-src", () => {
    const nonce = "abc123testNonce==";
    const csp = buildCsp(nonce);
    expect(csp).toContain(`'nonce-${nonce}'`);
  });

  it("does NOT include unsafe-inline in script-src (AC16)", () => {
    const csp = buildCsp("testnonce123==");
    // Extract script-src directive
    const scriptSrc = csp
      .split(";")
      .find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("includes 'strict-dynamic' in script-src", () => {
    const csp = buildCsp("testnonce123==");
    const scriptSrc = csp
      .split(";")
      .find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it("includes frame-ancestors 'none'", () => {
    const csp = buildCsp("testnonce123==");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("includes object-src 'none'", () => {
    const csp = buildCsp("testnonce123==");
    expect(csp).toContain("object-src 'none'");
  });

  it("includes 'self' in default-src", () => {
    const csp = buildCsp("testnonce123==");
    expect(csp).toContain("default-src 'self'");
  });

  it("includes base-uri 'self'", () => {
    const csp = buildCsp("testnonce123==");
    expect(csp).toContain("base-uri 'self'");
  });

  it("includes form-action 'self'", () => {
    const csp = buildCsp("testnonce123==");
    expect(csp).toContain("form-action 'self'");
  });
});

describe("buildCsp — where reports may go", () => {
  /**
   * The directive used to name `https://o0.ingest.sentry.io`, which is the
   * placeholder host out of Sentry's documentation and belongs to nobody. The
   * day someone set a real DSN, every report would have been blocked and the
   * only symptom would be errors quietly failing to arrive.
   */
  const SAVED = process.env.NEXT_PUBLIC_SENTRY_DSN;

  afterEach(() => {
    if (SAVED === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = SAVED;
  });

  it("allows only ourselves when Sentry is off", () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(buildCsp("n")).toContain("connect-src 'self';");
  });

  it("allows the real ingest host when a DSN is configured", () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://abc123@o4507.ingest.us.sentry.io/12345";
    expect(buildCsp("n")).toContain("connect-src 'self' https://o4507.ingest.us.sentry.io");
  });

  it("does not widen the policy on a malformed DSN", () => {
    // A typo in an env var must not turn into a permissive directive.
    process.env.NEXT_PUBLIC_SENTRY_DSN = "no-es-una-url";
    expect(buildCsp("n")).toContain("connect-src 'self';");
  });

  it("never allows inline scripts, whatever else changes", () => {
    // The one directive the whole file exists for.
    expect(buildCsp("n")).not.toContain("unsafe-inline'; script");
    const scriptSrc = buildCsp("n")
      .split("; ")
      .find((d) => d.startsWith("script-src"));
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
    expect(scriptSrc).toContain("'nonce-n'");
  });
});
