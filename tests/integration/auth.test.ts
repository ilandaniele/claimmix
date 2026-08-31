/**
 * Integration tests for authentication API routes.
 *
 * AC1: POST /api/auth/sign-in with valid credentials -> 200 + session
 * AC2: GET /api/cases (and other protected routes) without session -> 401
 * AC3: 6th sign-in attempt within 10s -> 429 with Retry-After
 *
 * These tests require a running Next.js dev server on http://localhost:3000.
 * Run with: pnpm test:integration (set TEST_BASE_URL env if different).
 *
 * For CI: start the dev server or use `next build && next start`.
 * Set INTEGRATION_TEST_EMAIL and INTEGRATION_TEST_PASSWORD to valid test creds.
 *
 * NOTE: These tests are NOT included in the unit test run (vitest.config.ts
 * excludes tests/integration/**). Run separately with:
 *   vitest run tests/integration --config vitest.integration.config.ts
 *
 * For now these tests validate the route contracts using the local API.
 * They will be skipped if TEST_BASE_URL is not set (local CI without server).
 */

import { describe, it, expect } from "vitest";

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const TEST_EMAIL = process.env.INTEGRATION_TEST_EMAIL ?? "lucia@seguros-del-sur.com.ar";
const TEST_PASSWORD = process.env.INTEGRATION_TEST_PASSWORD ?? "Analyst123!";

// Skip all tests if no server is available.
const shouldSkip = !process.env.TEST_BASE_URL && !process.env.INTEGRATION_ENABLED;

/*
 * No hay `beforeEach` que reinicie el limitador, y no es un olvido.
 *
 * Había uno que llamaba a `clearAllRateLimits()` y no servía para nada, por dos
 * razones a la vez: limpia el mapa en memoria de ESTE proceso —el del corredor
 * de tests— y no el del servidor que atiende los pedidos; y el servidor ni
 * siquiera cuenta en memoria, cuenta en Postgres, porque tiene `DATABASE_URL`.
 * Se leía como higiene entre tests y era una línea muerta.
 *
 * Lo que sí funciona es no compartir cupo: cada prueba que toca el techo usa una
 * clave propia. Ver AC3.
 */
describe.skipIf(shouldSkip)("POST /api/auth/sign-in", () => {

  it("AC1: returns 200 with user data on valid credentials", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
        // Un navegador SIEMPRE manda Origin; `fetch` de Node no.
        // Better Auth exige la cabecera en todo pedido que cambia estado
        // —es su defensa contra CSRF— y sin ella responde
        // MISSING_OR_NULL_ORIGIN. Mandarla no debilita nada: es lo que hace
        // el navegador de un analista.
        Origin: BASE_URL },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("user");
    expect(body.user).toHaveProperty("id");
    expect(body.user).toHaveProperty("email");
    // Better Auth devuelve `redirect: false` y un token. A dónde va la
    // persona después lo decide el cliente, no el servidor — este test
    // esperaba "/bandeja" de una ruta propia que ya no existe.
    expect(body).toHaveProperty("token");
    expect(typeof body.token).toBe("string");
  });

  it("returns 401 with INVALID_CREDENTIALS on wrong password", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
        // Un navegador SIEMPRE manda Origin; `fetch` de Node no.
        // Better Auth exige la cabecera en todo pedido que cambia estado
        // —es su defensa contra CSRF— y sin ella responde
        // MISSING_OR_NULL_ORIGIN. Mandarla no debilita nada: es lo que hace
        // el navegador de un analista.
        Origin: BASE_URL },
      body: JSON.stringify({ email: TEST_EMAIL, password: "wrongpassword!" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    // El código lo pone Better Auth. Lo que importa es que NO distinga entre
    // "ese mail no existe" y "esa clave está mal": un mensaje distinto para
    // cada caso le confirma a un atacante qué direcciones tienen cuenta.
    expect(body.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(JSON.stringify(body)).not.toMatch(/no existe|not found|unknown user/i);
  });

  it("returns 400 on invalid email format", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
        // Un navegador SIEMPRE manda Origin; `fetch` de Node no.
        // Better Auth exige la cabecera en todo pedido que cambia estado
        // —es su defensa contra CSRF— y sin ella responde
        // MISSING_OR_NULL_ORIGIN. Mandarla no debilita nada: es lo que hace
        // el navegador de un analista.
        Origin: BASE_URL },
      body: JSON.stringify({ email: "not-an-email", password: "somepassword" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_EMAIL");
  });

  it("returns 400 on missing password", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
        // Un navegador SIEMPRE manda Origin; `fetch` de Node no.
        // Better Auth exige la cabecera en todo pedido que cambia estado
        // —es su defensa contra CSRF— y sin ella responde
        // MISSING_OR_NULL_ORIGIN. Mandarla no debilita nada: es lo que hace
        // el navegador de un analista.
        Origin: BASE_URL },
      body: JSON.stringify({ email: TEST_EMAIL }),
    });

    expect(res.status).toBe(400);
  });

  it("AC3: returns 429 with Retry-After after 5 failed attempts", async () => {
    /*
     * Una dirección distinta en cada corrida, para estrenar contador.
     *
     * La clave del cupo es (IP, dirección). Con una dirección fija, los intentos
     * de una corrida anterior podían seguir contados en la ventana en curso y
     * el techo llegaba antes de lo que este test cree.
     */
    const direccion = `ratelimit-${Date.now()}@example.com`;

    const intento = () =>
      fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Un navegador siempre lo manda; sin él Better Auth responde 403 por
          // origen y nunca se llega a ver el techo.
          Origin: BASE_URL,
          // La IP fija hace que los seis intentos compartan cupo. En producción
          // la pone el borde.
          "X-Forwarded-For": "10.0.0.1",
        },
        body: JSON.stringify({
          email: direccion,
          password: "badpassword",
        }),
      });

    /*
     * Esperar a que la ventana en curso tenga lugar para los seis.
     *
     * La ventana es FIJA y alineada al reloj: `floor(now / 10s) * 10s`, igual en
     * todas las instancias, que es lo que las hace contar juntas. El costo está
     * escrito en `postgres.ts` — en el borde entre dos ventanas pasan hasta el
     * doble de intentos — y este test caía justo ahí: cinco pedidos en la
     * ventana N, el sexto en la N+1 estrenando contador, y 401 en vez de 429.
     * Fallaba una de cada tantas corridas y parecía intermitencia del runner.
     *
     * Así que no se cambia el limitador para que el test pase: se le da al test
     * la ventana entera que la afirmación necesita.
     */
    const VENTANA = 10_000;
    const faltaParaElBorde = VENTANA - (Date.now() % VENTANA);
    if (faltaParaElBorde < 4_000) {
      await new Promise((r) => setTimeout(r, faltaParaElBorde + 100));
    }

    /*
     * Los cinco salen JUNTOS, no uno tras otro.
     *
     * La ventana es de diez segundos, y en serie cada intento consulta la base:
     * en una máquina de CI los seis no entran, el sexto cae en una ventana
     * nueva y pasa. El test medía la velocidad del runner, no el techo.
     */
    await Promise.all(Array.from({ length: 5 }, intento));

    // El sexto, dentro de la misma ventana.
    const res = await intento();

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "0", 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(10);
  });
});

describe.skipIf(shouldSkip)("GET /api/cases (auth guard — AC2)", () => {
  it("AC2: returns 401 MISSING_SESSION without auth cookies", async () => {
    const res = await fetch(`${BASE_URL}/api/cases`, {
      method: "GET",
      headers: { "Content-Type": "application/json",
        // Un navegador SIEMPRE manda Origin; `fetch` de Node no.
        // Better Auth exige la cabecera en todo pedido que cambia estado
        // —es su defensa contra CSRF— y sin ella responde
        // MISSING_OR_NULL_ORIGIN. Mandarla no debilita nada: es lo que hace
        // el navegador de un analista.
        Origin: BASE_URL },
      // No cookie header — unauthenticated request.
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("MISSING_SESSION");
  });
});

describe.skipIf(shouldSkip)("POST /api/auth/sign-out", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-out`, {
      method: "POST",
      // Un cuerpo vacío pero presente: con `Content-Type: application/json` y
      // sin cuerpo, Better Auth responde 400 por el JSON que no puede parsear
      // — un 400 que no dice nada sobre la sesión.
      body: "{}",
      headers: { "Content-Type": "application/json",
        // Un navegador SIEMPRE manda Origin; `fetch` de Node no.
        // Better Auth exige la cabecera en todo pedido que cambia estado
        // —es su defensa contra CSRF— y sin ella responde
        // MISSING_OR_NULL_ORIGIN. Mandarla no debilita nada: es lo que hace
        // el navegador de un analista.
        Origin: BASE_URL },
    });

    // sign-out is in PUBLIC_PREFIXES in proxy.ts — returns 401 from route handler
    // Better Auth responde 200 `{success:true}` aunque no hubiera sesión, y
    // está bien: cerrar sesión es idempotente. Devolver 401 le confirmaría a
    // quien pregunta si esa cookie era válida, que es información gratis.
    //
    // Lo que sí importa es que no deje una sesión abierta ni devuelva datos.
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ success: true });
  });
});
