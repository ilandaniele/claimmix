/**
 * El segundo techo del login: el que cuenta por IP sola.
 *
 * El cupo por (IP, dirección) (`claveDeCupo("auth:in", ...)`) corta a quien
 * prueba contraseñas contra UNA cuenta. Pero con sólo ése, alguien con una
 * lista de diez mil direcciones tiene cinco intentos en cada una y ninguno en total:
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

import { NextRequest } from "next/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRateLimit } = vi.hoisted(() => ({ mockRateLimit: vi.fn() }));

vi.mock("@/lib/rate-limit/postgres", () => ({
  checkRateLimitPostgres: mockRateLimit,
  purgeExpiredRateLimits: vi.fn(),
}));

import {
  topePorIp,
  clientIpFromHeaders,
  RATE_LIMIT_CONFIGS,
} from "@/lib/rate-limit/index";
import { claveDeCupo } from "@/lib/rate-limit/clave";


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
      expect(claveDeCupo("auth:in", ip, `victima${i}@ejemplo.com`)).not.toBe(
        claveDeCupo("auth:in", ip, `victima${i + 1}@ejemplo.com`)
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

describe("GET /api/auth/sso-inquilino/callback", () => {
  /*
   * La vuelta del SSO valida un token y crea o vincula cuentas: es un GET que
   * trabaja, así que lleva el techo por IP. Leer la sesión, otro GET, no.
   */
  async function cargarRuta(topePorIpSimulado: ReturnType<typeof vi.fn>, handlerGet: ReturnType<typeof vi.fn>) {
    vi.resetModules();
    vi.doMock("better-auth/next-js", () => ({
      toNextJsHandler: () => ({ GET: handlerGet, POST: vi.fn() }),
    }));
    vi.doMock("@/lib/auth", () => ({ auth: {} }));
    vi.doMock("@/lib/rate-limit/index", async (original) => ({
      ...(await original<typeof import("@/lib/rate-limit/index")>()),
      topePorIp: topePorIpSimulado,
    }));
    return import("@/app/api/auth/[...all]/route");
  }

  const pedido = (ruta: string) =>
    new NextRequest(`http://x/api/auth/${ruta}`, { headers: { "x-vercel-forwarded-for": "1.2.3.4" } });

  it("con cupo, pasa a Better Auth", async () => {
    const tope = vi.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: 0 });
    const get = vi.fn().mockResolvedValue(new Response("ok"));
    const { GET } = await cargarRuta(tope, get);

    const res = await GET(pedido("sso-inquilino/callback?code=c&state=s"));

    expect(tope).toHaveBeenCalledWith("1.2.3.4");
    expect(get).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("ok");
  });

  it("sin cupo, vuelve a /login sin tocar Better Auth y dice cuánto esperar", async () => {
    const tope = vi.fn().mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 20_000 });
    const get = vi.fn();
    const { GET } = await cargarRuta(tope, get);

    const res = await GET(pedido("sso-inquilino/callback?code=c&state=s"));

    expect(get).not.toHaveBeenCalled();
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe(
      "/login?error=sso_fallo"
    );
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("leer la sesión no consume cupo", async () => {
    const tope = vi.fn();
    const get = vi.fn().mockResolvedValue(new Response("{}"));
    const { GET } = await cargarRuta(tope, get);

    await GET(pedido("get-session"));

    expect(tope).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
  });
});
