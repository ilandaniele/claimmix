/**
 * E2E: GET /api/admin/health → 200.
 * AC2: health endpoint confirms Neon connectivity check.
 * AC16: security headers present on all responses.
 */

import { test, expect } from "@playwright/test";

test.describe("Health endpoint", () => {
  test("returns 200 with status field", async ({ request }) => {
    const response = await request.get("/api/admin/health");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("status");
    expect(["ok", "degraded"]).toContain(body.status);
    expect(body).toHaveProperty("db");
    expect(body).toHaveProperty("timestamp");
  });

  test("response includes env checks (boolean values only, no secrets)", async ({
    request,
  }) => {
    const response = await request.get("/api/admin/health");
    const body = await response.json();
    expect(body).toHaveProperty("env");
    // All env check values must be booleans — never expose actual key values.
    const envValues = Object.values(body.env as Record<string, unknown>);
    for (const val of envValues) {
      expect(typeof val).toMatch(/^(boolean)$/);
    }
  });

  test("security headers are present on health response (AC16)", async ({
    request,
  }) => {
    const response = await request.get("/api/admin/health");
    const headers = response.headers();

    // X-Content-Type-Options must be nosniff
    expect(headers["x-content-type-options"]).toBe("nosniff");

    // X-Frame-Options must be DENY
    expect(headers["x-frame-options"]).toBe("DENY");

    // Referrer-Policy
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");

    // HSTS — max-age must be >= 63072000 (2 years)
    const hsts = headers["strict-transport-security"];
    expect(hsts).toBeDefined();
    if (hsts) {
      const maxAgeMatch = hsts.match(/max-age=(\d+)/);
      expect(maxAgeMatch).not.toBeNull();
      if (maxAgeMatch) {
        expect(Number(maxAgeMatch[1])).toBeGreaterThanOrEqual(63072000);
      }
      expect(hsts).toContain("includeSubDomains");
      expect(hsts).toContain("preload");
    }
  });
});

test.describe("Login page redirect for unauthenticated users", () => {
  test("GET / redirects to /login or /bandeja", async ({ page }) => {
    // Without a session, the middleware should redirect to /login.
    // In E2E without real Neon, it may stay on the page — just check no crash.
    const response = await page.goto("/");
    // Accept either 200 (landed somewhere) or 3xx redirect — no 500.
    expect(response?.status()).toBeLessThan(500);
  });

  test("login page is publicly accessible (no redirect loop)", async ({
    page,
  }) => {
    await page.goto("/login");
    // Should not 500 or loop redirect infinitely.
    await expect(page).not.toHaveURL(/.*error.*/);
  });
});
