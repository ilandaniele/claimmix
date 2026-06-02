/**
 * Upstash Redis rate limiter adapter (upgrade path from in-memory).
 *
 * This module is a stub for the Upstash sliding-window implementation.
 * Activate by setting:
 *   RATE_LIMIT_PROVIDER=upstash
 *   UPSTASH_REDIS_REST_URL=https://...
 *   UPSTASH_REDIS_REST_TOKEN=...
 *
 * When active, this replaces the in-memory store with a Redis-backed
 * sliding-window counter that persists across serverless cold starts and
 * multiple function instances.
 *
 * Usage: the rate-limit/index.ts facade selects between memory and upstash
 * based on the RATE_LIMIT_PROVIDER env var.
 */

// NOTE: Install @upstash/ratelimit and @upstash/redis when activating:
//   pnpm add @upstash/ratelimit @upstash/redis

export async function checkRateLimitUpstash(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  // Dynamic import to avoid bundling Upstash deps when not configured.
  // When RATE_LIMIT_PROVIDER !== 'upstash' this function is never called.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Ratelimit } = await import("@upstash/ratelimit" as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Redis } = await import("@upstash/redis" as any);

  const redis = Redis.fromEnv();
  const windowSeconds = Math.ceil(windowMs / 1000);

  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
    analytics: false,
    prefix: "claimmix:rl",
  });

  const result = await ratelimit.limit(key);

  return {
    allowed: result.success,
    remaining: result.remaining,
    resetAt: result.reset,
  };
}
