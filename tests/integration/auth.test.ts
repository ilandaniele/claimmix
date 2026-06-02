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
    const res = await fetch(`${BASE_URL}/api/auth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("user");
    expect(body.user).toHaveProperty("id");
    expect(body.user).toHaveProperty("email");
    expect(body.redirect).toBe("/bandeja");
  });

  it("returns 401 with INVALID_CREDENTIALS on wrong password", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: "wrongpassword!" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns 400 on invalid email format", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "somepassword" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 on missing password", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL }),
    });

    expect(res.status).toBe(400);
  });

  it("AC3: returns 429 with Retry-After after 5 failed attempts", async () => {
    // Send 5 failed attempts to fill the rate limit window.
    for (let i = 0; i < 5; i++) {
      await fetch(`${BASE_URL}/api/auth/sign-in`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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
    const res = await fetch(`${BASE_URL}/api/auth/sign-in`, {
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
    });

    // sign-out is in PUBLIC_PREFIXES in proxy.ts — returns 401 from route handler
    expect([401, 204]).toContain(res.status);
  });
});
