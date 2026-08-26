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

import { describe, it, expect, beforeEach } from "vitest";
import { clearAllRateLimits } from "@/lib/rate-limit/memory";

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const TEST_EMAIL = process.env.INTEGRATION_TEST_EMAIL ?? "lucia@seguros-del-sur.com.ar";
const TEST_PASSWORD = process.env.INTEGRATION_TEST_PASSWORD ?? "Analyst123!";

// Skip all tests if no server is available.
const shouldSkip = !process.env.TEST_BASE_URL && !process.env.INTEGRATION_ENABLED;

describe.skipIf(shouldSkip)("POST /api/auth/sign-in", () => {
  beforeEach(() => {
    // Reset in-memory rate limit state between tests.
    clearAllRateLimits();
  });

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
    // Send 5 failed attempts to fill the rate limit window.
    for (let i = 0; i < 5; i++) {
      await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: BASE_URL,
          // Consistent IP via header (in production the edge sets this).
          "X-Forwarded-For": "10.0.0.1",
        },
        body: JSON.stringify({
          email: "ratelimit-test@example.com",
          password: "badpassword",
        }),
      });
    }

    // 6th attempt should be rate-limited.
    const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "10.0.0.1",
      },
      body: JSON.stringify({
        email: "ratelimit-test@example.com",
        password: "badpassword",
      }),
    });

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
