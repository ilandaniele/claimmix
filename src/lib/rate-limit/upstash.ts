/**
 * Upstash Redis rate limiter adapter (upgrade path from in-memory).
 *
 * This module is a stub. Activate by:
 *   1. Installing: pnpm add @upstash/ratelimit @upstash/redis
 *   2. Setting env vars: RATE_LIMIT_PROVIDER=upstash, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *
 * Until the packages are installed, RATE_LIMIT_PROVIDER must remain "memory"
 * (the default). This file intentionally avoids any top-level imports of
 * optional packages so the build succeeds without them.
 */

type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number };

export async function checkRateLimitUpstash(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  // These imports fail gracefully at runtime if packages are not installed.
  // The dynamic import path prevents Turbopack from attempting to resolve
  // optional peer dependencies at build time.
  //
   
  let Ratelimit: any;
   
  let Redis: any;

  try {
    // Use indirect path via a variable to prevent static analysis from
    // failing the build when optional packages are not installed.
    const pkgRl = "@upstash/ratelimit";
    const pkgRedis = "@upstash/redis";
     
    ({ Ratelimit } = (await import(/* webpackIgnore: true */ pkgRl as any)) as any);
     
    ({ Redis } = (await import(/* webpackIgnore: true */ pkgRedis as any)) as any);
  } catch {
    throw new Error(
      "[ClaimMix] Upstash packages not installed. " +
        "Run: pnpm add @upstash/ratelimit @upstash/redis, " +
        "or set RATE_LIMIT_PROVIDER=memory to use the in-memory fallback."
    );
  }

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
