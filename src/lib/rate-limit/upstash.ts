/**
 * Upstash Redis rate limiter adapter (upgrade path from in-memory).
 *
 * This module is a stub. Activate by:
 *   1. Installing: pnpm add @upstash/ratelimit @upstash/redis
 *   2. Setting env vars: RATE_LIMIT_PROVIDER=upstash, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *
 * Hasta que los paquetes esten instalados, no pongas RATE_LIMIT_PROVIDER en
 * nada: el default se resuelve solo en `resolveProvider()` y es `postgres`
 * cuando hay DATABASE_URL.
 *
 * Aca decia que el default era "memory" y que la variable tenia que quedar en
 * ese valor. Es al reves y es peligroso: contar en memoria EN PRODUCCION es no
 * contar —cada invocacion serverless arranca con su propio mapa vacio, asi que
 * el sexto intento casi nunca cae en la misma instancia que los cinco
 * anteriores— y el propio `index.ts` avisa de eso a los gritos. Seguir esta
 * instruccion apagaba el tope del login sin que fallara nada.
 *
 * Este archivo evita a proposito cualquier import de nivel superior de los
 * paquetes opcionales, para que el build ande sin ellos.
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
