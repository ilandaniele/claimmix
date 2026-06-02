/**
 * Rate-limit facade — selects between in-memory and Upstash implementations.
 *
 * Default: in-memory (single-instance, no external deps).
 * Upgrade: set RATE_LIMIT_PROVIDER=upstash + Upstash env vars.
 *
 * Auth endpoint limits (per spec):
 *   /api/auth/sign-in: 5 attempts / 10s per IP+email tuple
 *   /api/intake/simulate: 30/min per user
 *   /api/cases*: 100/min per user
 *
 * AC3: 6th sign-in attempt within 10s returns 429 with Retry-After header.
 */

import {
  checkRateLimit as checkMemory,
  resetRateLimit,
  clearAllRateLimits,
} from "./memory";

export { resetRateLimit, clearAllRateLimits };

/**
 * Simple in-memory rate limiter — thin wrapper around the memory implementation.
 * Exported for direct use by /api/intake/email without needing the full rateLimit()
 * async wrapper (which handles Upstash fallback).
 *
 * @param identifier - Unique key (e.g. IP address for webhook endpoint)
 * @param maxRequests - Maximum requests allowed within the window
 * @param windowMs    - Window duration in milliseconds
 * @returns { allowed, retryAfter? } where retryAfter is seconds until reset
 */
export function checkRateLimit(
  identifier: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; retryAfter?: number } {
  const result = checkMemory(identifier, maxRequests, windowMs);
  if (result.allowed) {
    return { allowed: true };
  }
  const retryAfter = Math.ceil(Math.max(0, result.resetAt - Date.now()) / 1000);
  return { allowed: false, retryAfter };
}

/** Rate-limit configuration profiles */
export const RATE_LIMIT_CONFIGS = {
  /** Sign-in: 5 attempts per 10 seconds per IP+email */
  AUTH_SIGN_IN: { limit: 5, windowMs: 10_000 },
  /** Intake simulation: 30 per minute per user */
  INTAKE_SIMULATE: { limit: 30, windowMs: 60_000 },
  /** Cases API: 100 per minute per user */
  CASES_API: { limit: 100, windowMs: 60_000 },

  // ── Email-intake rate limits (spec §Security posture) ─────────────────────

  /**
   * EMAIL_INTAKE_WEBHOOK: 100 requests per 10 seconds per IP.
   * Protects /api/intake/email from flood attacks without blocking
   * legitimate Postmark delivery bursts. AC20.
   */
  EMAIL_INTAKE_WEBHOOK: { limit: 100, windowMs: 10_000 },

  /**
   * CONFIRM_FIELD: 30 requests per minute per user.
   * Protects /api/cases/:id/confirm-field from rapid-fire submissions.
   */
  CONFIRM_FIELD: { limit: 30, windowMs: 60_000 },

  /**
   * SYNC_TO_CORE: 5 requests per minute per user.
   * Protects /api/cases/:id/sync-to-core from accidental repeated sends.
   */
  SYNC_TO_CORE: { limit: 5, windowMs: 60_000 },
} as const;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix epoch ms when the oldest request in the window expires */
  resetAt: number;
  /** Seconds until the window resets (for Retry-After header) */
  retryAfterSeconds: number;
}

/**
 * Check the rate limit for the given key and profile.
 *
 * @param key    - Unique identifier string (e.g. "ip:email" or "user:id")
 * @param config - Limit configuration from RATE_LIMIT_CONFIGS
 */
export async function rateLimit(
  key: string,
  config: { limit: number; windowMs: number }
): Promise<RateLimitResult> {
  const provider = process.env.RATE_LIMIT_PROVIDER ?? "memory";

  let result: { allowed: boolean; remaining: number; resetAt: number };

  if (provider === "upstash") {
    const { checkRateLimitUpstash } = await import("./upstash");
    result = await checkRateLimitUpstash(key, config.limit, config.windowMs);
  } else {
    result = checkMemory(key, config.limit, config.windowMs);
  }

  const retryAfterSeconds = Math.ceil(
    Math.max(0, result.resetAt - Date.now()) / 1000
  );

  return {
    ...result,
    retryAfterSeconds,
  };
}

/**
 * Build a rate-limit key for sign-in using IP + email.
 * Combining both prevents per-IP flooding as well as per-email brute force.
 */
export function buildSignInKey(ip: string, email: string): string {
  // Lowercase email to prevent case-variation bypass.
  return `signin:${ip}:${email.toLowerCase().trim()}`;
}

/**
 * Build a rate-limit key for authenticated user endpoints.
 */
export function buildUserKey(userId: string, endpoint: string): string {
  return `user:${userId}:${endpoint}`;
}

/**
 * Extract client IP from a Next.js Request.
 *
 * On Vercel: use `import { ipAddress } from '@vercel/functions'` for verified IP.
 * This fallback reads x-forwarded-for (Vercel sets this at the edge layer).
 * On non-Vercel hosts, strip user-supplied x-forwarded-for at the load balancer.
 */
export function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xReal = request.headers.get("x-real-ip");
  if (xReal) return xReal.trim();
  return "anonymous";
}
