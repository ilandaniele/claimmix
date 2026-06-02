/**
 * Unit tests for the email-intake rate limiter extensions.
 *
 * Tests the new RATE_LIMIT_CONFIGS entries and the checkRateLimit
 * convenience wrapper exported from src/lib/rate-limit/index.ts.
 *
 * AC20: 100 webhook requests/10s per IP; 101st returns 429 with Retry-After.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkRateLimit,
  RATE_LIMIT_CONFIGS,
  clearAllRateLimits,
} from "@/lib/rate-limit/index";

describe("RATE_LIMIT_CONFIGS — email-intake entries", () => {
  it("EMAIL_INTAKE_WEBHOOK is 100 requests per 10 seconds", () => {
    expect(RATE_LIMIT_CONFIGS.EMAIL_INTAKE_WEBHOOK.limit).toBe(100);
    expect(RATE_LIMIT_CONFIGS.EMAIL_INTAKE_WEBHOOK.windowMs).toBe(10_000);
  });

  it("CONFIRM_FIELD is 30 requests per minute", () => {
    expect(RATE_LIMIT_CONFIGS.CONFIRM_FIELD.limit).toBe(30);
    expect(RATE_LIMIT_CONFIGS.CONFIRM_FIELD.windowMs).toBe(60_000);
  });

  it("SYNC_TO_CORE is 5 requests per minute", () => {
    expect(RATE_LIMIT_CONFIGS.SYNC_TO_CORE.limit).toBe(5);
    expect(RATE_LIMIT_CONFIGS.SYNC_TO_CORE.windowMs).toBe(60_000);
  });
});

describe("checkRateLimit wrapper — email-intake webhook", () => {
  beforeEach(() => {
    clearAllRateLimits();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to EMAIL_INTAKE_WEBHOOK limit", () => {
    const ip = "203.0.113.1";
    const { limit, windowMs } = RATE_LIMIT_CONFIGS.EMAIL_INTAKE_WEBHOOK;

    // First request should be allowed
    const result = checkRateLimit(ip, limit, windowMs);
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBeUndefined();
  });

  it("blocks request over the limit and returns retryAfter (AC20)", () => {
    vi.useFakeTimers();
    const ip = "203.0.113.2";
    const { limit, windowMs } = RATE_LIMIT_CONFIGS.EMAIL_INTAKE_WEBHOOK;

    // Exhaust the limit
    for (let i = 0; i < limit; i++) {
      const r = checkRateLimit(ip, limit, windowMs);
      expect(r.allowed).toBe(true);
    }

    // Next request should be blocked
    const blocked = checkRateLimit(ip, limit, windowMs);
    expect(blocked.allowed).toBe(false);
    expect(typeof blocked.retryAfter).toBe("number");
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("resets after the window expires", () => {
    vi.useFakeTimers();
    const ip = "203.0.113.3";
    const limit = 3;
    const windowMs = 10_000;

    // Fill limit
    for (let i = 0; i < limit; i++) {
      checkRateLimit(ip, limit, windowMs);
    }

    expect(checkRateLimit(ip, limit, windowMs).allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(windowMs + 1);

    const result = checkRateLimit(ip, limit, windowMs);
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBeUndefined();
  });

  it("different IPs have independent counters", () => {
    const limit = 1;
    const windowMs = 10_000;

    checkRateLimit("ip1", limit, windowMs);

    expect(checkRateLimit("ip1", limit, windowMs).allowed).toBe(false);
    expect(checkRateLimit("ip2", limit, windowMs).allowed).toBe(true);
  });

  it("SYNC_TO_CORE limit is enforced (5 per minute)", () => {
    vi.useFakeTimers();
    const userId = "user:uuid-sync-test";
    const { limit, windowMs } = RATE_LIMIT_CONFIGS.SYNC_TO_CORE;

    for (let i = 0; i < limit; i++) {
      expect(checkRateLimit(userId, limit, windowMs).allowed).toBe(true);
    }

    const blocked = checkRateLimit(userId, limit, windowMs);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("CONFIRM_FIELD limit is enforced (30 per minute)", () => {
    vi.useFakeTimers();
    const userId = "user:uuid-confirm-test";
    const { limit, windowMs } = RATE_LIMIT_CONFIGS.CONFIRM_FIELD;

    for (let i = 0; i < limit; i++) {
      expect(checkRateLimit(userId, limit, windowMs).allowed).toBe(true);
    }

    const blocked = checkRateLimit(userId, limit, windowMs);
    expect(blocked.allowed).toBe(false);
  });

  it("retryAfter is a non-negative integer (for Retry-After HTTP header)", () => {
    vi.useFakeTimers();
    const ip = "203.0.113.10";
    const limit = 1;
    const windowMs = 5_000;

    checkRateLimit(ip, limit, windowMs);
    const result = checkRateLimit(ip, limit, windowMs);

    expect(result.allowed).toBe(false);
    expect(typeof result.retryAfter).toBe("number");
    expect(result.retryAfter!).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.retryAfter!)).toBe(true);
  });
});
