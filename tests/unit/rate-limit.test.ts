/**
 * Unit tests for the in-memory rate limiter.
 *
 * AC3: 5 attempts allowed, 6th returns allowed=false within 10s window.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkRateLimit,
  resetRateLimit,
  clearAllRateLimits,
} from "@/lib/rate-limit/memory";

describe("in-memory rate limiter", () => {
  beforeEach(() => {
    clearAllRateLimits();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the limit", () => {
    const key = "test:ip:user@example.com";
    const limit = 5;
    const windowMs = 10_000;

    for (let i = 0; i < limit; i++) {
      const result = checkRateLimit(key, limit, windowMs);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(limit - i - 1);
    }
  });

  it("blocks the request exceeding the limit (AC3: 6th attempt)", () => {
    const key = "test:ip:user@example.com";
    const limit = 5;
    const windowMs = 10_000;

    // 5 allowed
    for (let i = 0; i < limit; i++) {
      checkRateLimit(key, limit, windowMs);
    }

    // 6th blocked
    const result = checkRateLimit(key, limit, windowMs);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("resets after the window expires", () => {
    vi.useFakeTimers();
    const key = "test:window:user@example.com";
    const limit = 5;
    const windowMs = 10_000;

    // Fill limit
    for (let i = 0; i < limit; i++) {
      checkRateLimit(key, limit, windowMs);
    }

    // Blocked
    expect(checkRateLimit(key, limit, windowMs).allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(windowMs + 1);

    // Should be allowed again
    const result = checkRateLimit(key, limit, windowMs);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(limit - 1);
  });

  it("provides a non-zero retryAfterSeconds when blocked", () => {
    const key = "test:retry:user@example.com";
    const limit = 2;
    const windowMs = 10_000;

    checkRateLimit(key, limit, windowMs);
    checkRateLimit(key, limit, windowMs);

    const result = checkRateLimit(key, limit, windowMs);
    expect(result.allowed).toBe(false);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it("tracks different keys independently", () => {
    const limit = 1;
    const windowMs = 10_000;

    checkRateLimit("key:a", limit, windowMs);
    checkRateLimit("key:b", limit, windowMs);

    // key:a should be blocked (1/1 used)
    expect(checkRateLimit("key:a", limit, windowMs).allowed).toBe(false);
    // key:b should also be blocked (1/1 used)
    expect(checkRateLimit("key:b", limit, windowMs).allowed).toBe(false);
    // key:c should be allowed (never used)
    expect(checkRateLimit("key:c", limit, windowMs).allowed).toBe(true);
  });

  it("resetRateLimit clears the counter for a specific key", () => {
    const key = "test:reset:user@example.com";
    const limit = 1;
    const windowMs = 10_000;

    checkRateLimit(key, limit, windowMs);
    expect(checkRateLimit(key, limit, windowMs).allowed).toBe(false);

    resetRateLimit(key);

    expect(checkRateLimit(key, limit, windowMs).allowed).toBe(true);
  });

  it("remaining is never negative", () => {
    const key = "test:negative:user@example.com";
    const limit = 2;
    const windowMs = 10_000;

    // Exhaust the limit
    checkRateLimit(key, limit, windowMs);
    checkRateLimit(key, limit, windowMs);

    // Multiple blocked attempts
    const r1 = checkRateLimit(key, limit, windowMs);
    const r2 = checkRateLimit(key, limit, windowMs);

    expect(r1.remaining).toBe(0);
    expect(r2.remaining).toBe(0);
  });

  it("sliding window: old requests expire as time passes", () => {
    vi.useFakeTimers();
    const key = "test:sliding:user@example.com";
    const limit = 3;
    const windowMs = 10_000; // 10s

    // t=0: 3 requests fill the window
    for (let i = 0; i < 3; i++) {
      checkRateLimit(key, limit, windowMs);
    }

    // t=0: blocked
    expect(checkRateLimit(key, limit, windowMs).allowed).toBe(false);

    // t=5s: first request from t=0 has NOT expired yet (window is 10s)
    vi.advanceTimersByTime(5_000);
    expect(checkRateLimit(key, limit, windowMs).allowed).toBe(false);

    // t=10s+1ms: all t=0 requests have expired
    vi.advanceTimersByTime(5_001);
    expect(checkRateLimit(key, limit, windowMs).allowed).toBe(true);
  });
});

describe("rate-limit facade", () => {
  beforeEach(() => {
    clearAllRateLimits();
    vi.unstubAllEnvs();
  });

  it("uses memory provider by default", async () => {
    vi.stubEnv("RATE_LIMIT_PROVIDER", "memory");
    const { rateLimit, buildSignInKey, RATE_LIMIT_CONFIGS } = await import(
      "@/lib/rate-limit/index"
    );

    const key = buildSignInKey("127.0.0.1", "test@example.com");
    const result = await rateLimit(key, RATE_LIMIT_CONFIGS.AUTH_SIGN_IN);
    expect(result.allowed).toBe(true);
    expect(typeof result.remaining).toBe("number");
    expect(typeof result.retryAfterSeconds).toBe("number");
  });

  it("buildSignInKey normalizes email to lowercase", async () => {
    const { buildSignInKey } = await import("@/lib/rate-limit/index");
    const key1 = buildSignInKey("1.2.3.4", "User@Example.COM");
    const key2 = buildSignInKey("1.2.3.4", "user@example.com");
    expect(key1).toBe(key2);
  });

  it("getClientIp reads x-forwarded-for first", async () => {
    const { getClientIp } = await import("@/lib/rate-limit/index");
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2" },
    });
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("getClientIp falls back to x-real-ip", async () => {
    const { getClientIp } = await import("@/lib/rate-limit/index");
    const req = new Request("http://localhost", {
      headers: { "x-real-ip": "192.168.1.100" },
    });
    expect(getClientIp(req)).toBe("192.168.1.100");
  });

  it("getClientIp returns 'anonymous' when no IP headers", async () => {
    const { getClientIp } = await import("@/lib/rate-limit/index");
    const req = new Request("http://localhost");
    expect(getClientIp(req)).toBe("anonymous");
  });
});
