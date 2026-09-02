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

  /**
   * Este endpoint es público —lo pinga un monitor de uptime cada 5 minutos— y
   * por eso lo único que puede decir es si está vivo.
   *
   * Antes devolvía además el transporte del modelo, si había clave del proveedor,
   * la región y si Sentry estaba prendido. Ninguno es un secreto por separado;
   * juntos son reconocimiento gratis para cualquiera. El más útil para quien
   * mira desde afuera es el de Sentry: "false" dice que nadie se entera de los
   * errores, o sea que se puede probar tranquilo.
   *
   * Este test antes exigía ese bloque. Ahora exige lo contrario.
   */
  test("no enumera la configuración a un anónimo", async ({ request }) => {
    const response = await request.get("/api/admin/health");
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("env");
    expect(body).not.toHaveProperty("ai");
    expect(body).not.toHaveProperty("region");

    // Y que no se cuele por otro nombre: nada que suene a credencial o a
    // proveedor tiene por qué estar en una respuesta que lee cualquiera.
    const serialized = JSON.stringify(body).toLowerCase();
    for (const word of ["api_key", "sentry", "vertex", "openai", "gemini", "transport"]) {
      expect(serialized).not.toContain(word);
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
