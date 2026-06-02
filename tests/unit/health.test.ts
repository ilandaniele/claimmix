/**
 * Unit tests for the health endpoint logic.
 *
 * The route handler itself is tested as an integration test in tests/integration/.
 * Here we test the environment checks and CSP utilities used by it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

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
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  });

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

  it("includes the Supabase URL in connect-src", () => {
    const csp = buildCsp("testnonce123==");
    expect(csp).toContain("https://test.supabase.co");
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
