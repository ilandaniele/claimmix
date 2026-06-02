/**
 * In-memory sliding-window rate limiter using an LRU-style Map.
 *
 * Limitation: state is lost on serverless cold starts (each Vercel function
 * instance has its own in-memory state). This is acceptable for MVP.
 *
 * Upgrade path: swap for Upstash Redis (see rate-limit/upstash.ts) when
 * multi-instance consistency is required.
 *
 * The Map is capped at MAX_KEYS entries to prevent unbounded memory growth.
 * Entries older than the window are garbage-collected on access.
 */

const MAX_KEYS = 10_000;

interface WindowEntry {
  timestamps: number[]; // epoch ms of each request within the window
}

// Module-level store — survives hot-reloads in dev, reset on cold starts in prod.
const store = new Map<string, WindowEntry>();

/**
 * Check whether a key has exceeded the allowed request count within the window.
 *
 * @param key      - Unique identifier (e.g. "ip:email" tuple)
 * @param limit    - Maximum requests allowed within the window
 * @param windowMs - Window duration in milliseconds
 * @returns `{ allowed: boolean; remaining: number; resetAt: number }`
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const windowStart = now - windowMs;

  // Evict one old entry if at capacity to prevent unbounded growth.
  if (store.size >= MAX_KEYS) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) {
      store.delete(firstKey);
    }
  }

  const entry = store.get(key) ?? { timestamps: [] };

  // Purge timestamps outside the current window (sliding window).
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  const count = entry.timestamps.length;
  const allowed = count < limit;

  if (allowed) {
    entry.timestamps.push(now);
  }

  store.set(key, entry);

  // Reset time = when the oldest request in the window expires.
  const oldestInWindow = entry.timestamps[0] ?? now;
  const resetAt = oldestInWindow + windowMs;

  return {
    allowed,
    remaining: Math.max(0, limit - entry.timestamps.length),
    resetAt,
  };
}

/**
 * Reset the rate-limit counter for a key. Useful in tests.
 */
export function resetRateLimit(key: string): void {
  store.delete(key);
}

/**
 * Clear all rate-limit state. Use in tests only.
 */
export function clearAllRateLimits(): void {
  store.clear();
}
