/**
 * Rate-limit facade — Postgres by default, memory in tests, Upstash if asked.
 *
 * It used to default to memory, and on serverless that means counting per
 * instance. Vercel answers parallel requests by starting more instances, each
 * one beginning its count at zero — so the person who makes the limit weakest
 * is the one sending the most requests at once, which is exactly who it exists
 * to stop. The load test made it concrete: a hundred simultaneous requests
 * served without any single instance seeing more than a handful.
 *
 * Postgres is the only thing every instance shares, and it is already there.
 * No extra vendor, no extra credential to rotate, nothing new to expire
 * unnoticed. RATE_LIMIT_PROVIDER can still force `upstash` or `memory`.
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
 * Synchronous, memory-only limiter.
 *
 * Written for /api/intake/email, which is now a 410 stub — nothing in the
 * application calls this any more, only its tests. Left in place because a
 * synchronous limiter is occasionally the only option (no await available),
 * but do not reach for it: being memory-only it counts per instance, which on
 * serverless means counting per attacker. Use `rateLimit()`.
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
  /**
   * Intentos de autenticación por IP, sin mirar contra qué cuenta.
   *
   * El cupo de arriba es por (IP, dirección) y frena a quien ataca UNA cuenta.
   * Éste frena al que recorre una lista: treinta intentos por minuto desde una
   * misma IP, contra las direcciones que sea.
   *
   * Treinta y no cinco porque una oficina entera comparte IP detrás de un NAT,
   * y media docena de personas entrando a las nueve de la mañana no puede
   * quedar trabada. Un atacante recorriendo diez mil direcciones sí.
   */
  AUTH_POR_IP: { limit: 30, windowMs: 60_000 },
  /** Sign-up: 3 new accounts per minute per IP */
  AUTH_SIGN_UP: { limit: 3, windowMs: 60_000 },

  /*
   * Pedir un enlace de recuperacion: tres por hora y por direccion.
   *
   * Este endpoint MANDA UN MAIL a una direccion que elige quien llama, asi que
   * sin techo es un amplificador: uno pide mil veces y la casilla de otro
   * recibe mil mensajes desde una direccion en la que confia. No hace falta
   * adivinar nada para que moleste.
   *
   * La ventana es larga a proposito. Recuperar la contrasena es algo que una
   * persona hace una vez y despues va a buscar el mail; reintentar tres veces
   * en una hora ya es raro, y el cuarto intento no le sirve de nada porque el
   * enlace anterior sigue vivo.
   */
  AUTH_RESET: { limit: 3, windowMs: 60 * 60_000 },
  /** Intake simulation: 30 per minute per user */
  INTAKE_SIMULATE: { limit: 30, windowMs: 60_000 },
  /** Cases API: 100 per minute per user */
  CASES_API: { limit: 100, windowMs: 60_000 },

  // ── Email-intake rate limits (spec §Security posture) ─────────────────────

  /**
   * EMAIL_INTAKE_WEBHOOK: 100 requests per 10 seconds per IP.
   * Protects /api/intake/email from flood attacks without blocking
   * legitimate provider delivery bursts. AC20.
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

/**
 * Which implementation counts.
 *
 * The tests run against memory on purpose: they are about the limiting logic,
 * they run thousands of times, and none of them should need a database to say
 * whether a sixth attempt in ten seconds is refused.
 */
export function resolveProvider(): "postgres" | "memory" | "upstash" {
  const forced = process.env.RATE_LIMIT_PROVIDER?.trim().toLowerCase();
  if (forced === "upstash" || forced === "memory" || forced === "postgres") {
    avisarSiEsMemoriaEnProduccion(forced, "RATE_LIMIT_PROVIDER lo fuerza");
    return forced;
  }
  if (process.env.NODE_ENV === "test") return "memory";

  const elegido = process.env.DATABASE_URL ? "postgres" : "memory";
  avisarSiEsMemoriaEnProduccion(elegido, "falta DATABASE_URL");
  return elegido;
}

/**
 * Contar en memoria, en producción, es no contar.
 *
 * Cada invocación serverless arranca con su propio mapa vacío, así que el sexto
 * intento de la ventana casi nunca cae en la misma instancia que los cinco
 * anteriores: el tope del login deja de existir, y nada falla — sigue
 * respondiendo «permitido» a todo.
 *
 * No se corta la aplicación por esto: dejar el producto abajo porque falta una
 * variable es peor que dejarlo sin tope. Pero deja de ser silencioso, que era
 * el problema: un límite que no limita y no avisa es la peor de las tres
 * opciones.
 */
function avisarSiEsMemoriaEnProduccion(proveedor: string, motivo: string): void {
  if (proveedor !== "memory") return;
  if (process.env.NODE_ENV !== "production") return;

  console.error(
    JSON.stringify({
      level: "error",
      service: "claimmix",
      msg: "rate_limit.memoria_en_produccion",
      motivo,
      detalle:
        "El límite de tráfico cuenta en memoria: en serverless cada instancia " +
        "tiene la suya, así que en la práctica no hay tope.",
    })
  );
}

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
  const provider = resolveProvider();

  let result: { allowed: boolean; remaining: number; resetAt: number };

  if (provider === "upstash") {
    const { checkRateLimitUpstash } = await import("./upstash");
    result = await checkRateLimitUpstash(key, config.limit, config.windowMs);
  } else if (provider === "postgres") {
    const { checkRateLimitPostgres } = await import("./postgres");
    result = await checkRateLimitPostgres(key, config.limit, config.windowMs);
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
 * El techo por IP sola de los caminos de autenticación.
 *
 * Es el segundo tope, y frena un ataque distinto del de `buildSignInKey`. Ese
 * es por (IP, dirección): corta a quien prueba contraseñas contra UNA cuenta.
 * Pero con sólo ése, alguien con una lista de diez mil direcciones tiene cinco
 * intentos en cada una y ninguno en total — cincuenta mil pruebas desde una
 * sola IP sin tocar el techo. Es el ataque más común contra un login: no
 * adivinar la contraseña de una persona, sino probar una contraseña conocida
 * contra mucha gente.
 *
 * Vive acá y no escrito a mano en cada llamador porque la clave TIENE que ser
 * la misma en todos: dos formas de escribir `auth:ip:…` son dos cupos
 * distintos, y el que atacan es el que tenga el número más alto. La ruta HTTP
 * lo aplicaba y los Server Actions del login y de la recuperación no, así que
 * el camino que usa el formulario de la pantalla era el que no tenía techo.
 */
export function topePorIp(ip: string): Promise<RateLimitResult> {
  return rateLimit(`auth:ip:${ip}`, RATE_LIMIT_CONFIGS.AUTH_POR_IP);
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
  return clientIpFromHeaders(request.headers);
}

/**
 * La misma decisión, pero desde unos `Headers` sueltos.
 *
 * Existe por los Server Actions: ahí no hay `Request`, hay `await headers()`.
 * Sin esto, cada uno resolvía la IP a mano —`x-forwarded-for` partido por
 * coma— y se perdía la preferencia por `x-vercel-forwarded-for`, que es la
 * única cabecera que no puede escribir quien llama.
 */
export function clientIpFromHeaders(headers: Headers): string {
  /*
   * Esto toma el valor de más a la IZQUIERDA de `X-Forwarded-For`, que en el
   * caso general lo escribe quien llama y no vale nada. Acá sirve por una razón
   * concreta, y conviene que esté escrita: **Vercel sobrescribe esa cabecera en
   * el borde** con la IP real, así que lo que llega al código no es lo que mandó
   * el cliente.
   *
   * Comprobado contra producción: doce pedidos con `X-Forwarded-For: 9.9.9.9` y
   * después doce rotando `10.0.0.1..12`. Si la cabecera forjada llegara, la
   * segunda tanda habría estrenado cupo doce veces; dio 429 las doce, o sea que
   * las veinticuatro compartieron el cupo de la IP de verdad.
   *
   * Lo que esto significa: el límite de tráfico —el del login, el de la pantalla
   * pública, el del webhook— depende de una garantía de la plataforma. El día
   * que esto corra detrás de otro proxy, o directo, la cabecera vuelve a ser del
   * atacante y todos los topes se saltean rotando un valor.
   *
   * Por eso `x-vercel-forwarded-for` va primero cuando está: la pone Vercel y
   * sólo Vercel, así que no depende de que nadie más se comporte.
   */
  const deVercel = headers.get("x-vercel-forwarded-for");
  if (deVercel) return deVercel.split(",")[0].trim();

  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xReal = headers.get("x-real-ip");
  if (xReal) return xReal.trim();
  return "anonymous";
}
