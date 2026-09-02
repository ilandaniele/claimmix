/**
 * El segundo techo del login: el que cuenta por IP sola.
 *
 * `buildSignInKey` cuenta por (IP, dirección) y corta a quien prueba
 * contraseñas contra UNA cuenta. Pero con sólo ése, alguien con una lista de
 * diez mil direcciones tiene cinco intentos en cada una y ninguno en total:
 * cincuenta mil pruebas desde una sola IP sin tocar el techo. Es el ataque más
 * común contra un login — no adivinar la contraseña de una persona, sino probar
 * una contraseña conocida contra mucha gente.
 *
 * La ruta HTTP lo aplicaba. Los Server Actions del login y de la recuperación
 * —que son los que usa el formulario de la pantalla, o sea el camino real de la
 * gente— aplicaban sólo el primero.
 *
 * Lo que se afirma acá es la parte que se rompe en silencio: que la CLAVE sea
 * una sola. Dos formas de escribir `auth:ip:…` son dos cupos distintos, y el
 * que atacan es el que tenga el número más alto.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRateLimit } = vi.hoisted(() => ({ mockRateLimit: vi.fn() }));

vi.mock("@/lib/rate-limit/postgres", () => ({
  checkRateLimitPostgres: mockRateLimit,
  purgeExpiredRateLimits: vi.fn(),
}));

import {
  topePorIp,
  buildSignInKey,
  clientIpFromHeaders,
  RATE_LIMIT_CONFIGS,
} from "@/lib/rate-limit/index";


beforeEach(() => {
  vi.clearAllMocks();
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  delete process.env.RATE_LIMIT_PROVIDER;
});

describe("topePorIp", () => {
  it("cuenta por IP sola, sin la dirección", async () => {
    // Es lo que lo hace distinto del otro tope: dos direcciones desde la misma
    // IP comparten cupo.
    const unaIp = await topePorIp("203.0.113.7");
    const otraVez = await topePorIp("203.0.113.7");

    expect(unaIp.allowed).toBe(true);
    expect(otraVez.remaining).toBeLessThan(unaIp.remaining);
  });

  it("dos IPs distintas no comparten cupo", async () => {
    const a = await topePorIp("203.0.113.1");
    const b = await topePorIp("203.0.113.2");

    expect(a.remaining).toBe(b.remaining);
  });

  it("usa el perfil por IP y no el de (IP, dirección)", async () => {
    /*
     * La primera versión de este test sólo comparaba las dos constantes, y por
     * eso pasaba en verde cuando cambié `topePorIp` para que usara el perfil
     * equivocado: afirmaba que los números difieren, no cuál usa la función.
     *
     * Ahora se cuenta: con el perfil de (IP, dirección) —que es más chico— se
     * quedaría sin cupo antes de llegar a este número.
     */
    expect(RATE_LIMIT_CONFIGS.AUTH_POR_IP.limit).toBeGreaterThan(
      RATE_LIMIT_CONFIGS.AUTH_SIGN_IN.limit
    );

    const ip = "203.0.113.55";
    let ultimo = await topePorIp(ip);
    for (let i = 1; i < RATE_LIMIT_CONFIGS.AUTH_SIGN_IN.limit + 1; i++) {
      ultimo = await topePorIp(ip);
    }

    // Un intento más que el tope chico, y todavía tiene cupo.
    expect(ultimo.allowed).toBe(true);
  });

  it("recorrer una lista de direcciones agota el cupo de la IP", async () => {
    /*
     * El ataque concreto. Con sólo el tope por (IP, dirección), cada correo
     * nuevo estrena cupo y nunca se llega al techo.
     */
    const ip = "203.0.113.99";
    const tope = RATE_LIMIT_CONFIGS.AUTH_POR_IP.limit;

    let ultimo = await topePorIp(ip);
    for (let i = 1; i < tope + 1; i++) {
      // Cada intento sería contra una dirección distinta: el otro tope no lo vería.
      expect(buildSignInKey(ip, `victima${i}@ejemplo.com`)).not.toBe(
        buildSignInKey(ip, `victima${i + 1}@ejemplo.com`)
      );
      ultimo = await topePorIp(ip);
    }

    expect(ultimo.allowed).toBe(false);
  });
});

describe("clientIpFromHeaders", () => {
  it("prefiere la cabecera que pone Vercel", () => {
    /*
     * `x-forwarded-for` la escribe quien llama en el caso general. En Vercel la
     * sobrescribe el borde, pero `x-vercel-forwarded-for` la pone Vercel y sólo
     * Vercel: no depende de que nadie más se comporte.
     */
    const h = new Headers({
      "x-vercel-forwarded-for": "198.51.100.5",
      "x-forwarded-for": "9.9.9.9",
    });

    expect(clientIpFromHeaders(h)).toBe("198.51.100.5");
  });

  it("toma el primer valor de la lista", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" });
    expect(clientIpFromHeaders(h)).toBe("203.0.113.7");
  });

  it("sin ninguna cabecera devuelve algo, no undefined", () => {
    // Va a parar a una clave de cupo: un undefined la rompería.
    expect(clientIpFromHeaders(new Headers())).toBe("anonymous");
  });
});
