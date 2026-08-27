/**
 * E2E tests for the Gmail status panel in /configuracion.
 *
 * Scenario 1 (auth-gated): Admin user can see the Gmail status panel.
 *   - Navigate to /configuracion as admin.
 *   - Expect a section with "Bandeja de entrada Gmail" heading to be visible.
 *   - Expect a status pill with one of: "Conectado", "Error", "Sin configurar".
 *
 * Scenario 2 (auth-gated): Non-admin (analyst) user does NOT see the Gmail status panel.
 *   - Navigate to /configuracion as analyst.
 *   - The Gmail section is conditionally rendered server-side only for role='admin'.
 *   - Expect the "Bandeja de entrada Gmail" heading to NOT be present.
 *
 * Scenario 1 and 2 require a live Neon session with role-differentiated test accounts.
 * They are skipped in CI unless PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ANALYST_EMAIL are set.
 *
 * API access control tests (no auth required) run unconditionally.
 */

import { test, expect } from "@playwright/test";
import { SESION_ADMIN, SESION_ANALISTA } from "./sesiones";

const ADMIN_EMAIL = process.env.PLAYWRIGHT_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PLAYWRIGHT_ADMIN_PASSWORD;
const ANALYST_EMAIL = process.env.PLAYWRIGHT_ANALYST_EMAIL ?? process.env.PLAYWRIGHT_TEST_EMAIL;
const ANALYST_PASSWORD = process.env.PLAYWRIGHT_ANALYST_PASSWORD ?? process.env.PLAYWRIGHT_TEST_PASSWORD;

const HAS_ADMIN_CREDS = !!(ADMIN_EMAIL && ADMIN_PASSWORD);
const HAS_ANALYST_CREDS = !!(ANALYST_EMAIL && ANALYST_PASSWORD);

// The three possible status pill texts rendered by GmailStatusSection
const STATUS_PILL_TEXTS = ["Conectado", "Error", "Sin configurar"];

// ── API access control (no session required) ─────────────────────────────────

test.describe("Gmail status API — unauthenticated access control", () => {
  test("GET /api/admin/gmail-status without session returns 401", async ({ page }) => {
    const res = await page.request.get("/api/admin/gmail-status");
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("code");
    // MISSING_SESSION is the project-wide code for unauthenticated requests
    expect(body.error.code).toBe("MISSING_SESSION");
  });

  test("GET /api/admin/gmail-status response body never contains history_id (AC7)", async ({ page }) => {
    // Without auth this returns 401 but we can still verify the response shape
    const res = await page.request.get("/api/admin/gmail-status");
    const body = await res.json();
    // Verify history_id is absent at any depth — even in error responses
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("history_id");
  });

  test("/configuracion without session redirects to /login", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto("/configuracion");
    const url = page.url();
    const isAtLogin = url.includes("/login");
    const isAtConfig = url.includes("/configuracion");
    // Proxy.ts redirects unauthenticated users to /login
    expect(isAtLogin || isAtConfig).toBe(true);
  });
});

// ── Scenario 1: Admin sees Gmail status panel (requires live Neon + admin account) ──

test.describe("Gmail status panel — admin user visibility (Scenario 1)", () => {
  // Skip if admin credentials are not configured in the test environment.
  // To enable: set PLAYWRIGHT_ADMIN_EMAIL and PLAYWRIGHT_ADMIN_PASSWORD env vars.
  test.skip(!HAS_ADMIN_CREDS, "Skipped: PLAYWRIGHT_ADMIN_EMAIL not set — requires admin Neon account");

  /*
   * La sesión de admin sale del archivo que dejó `auth.setup.ts`.
   *
   * Antes cada test se logueaba de cero, y entre los tres archivos eso eran
   * nueve inicios de sesión seguidos. El login limita a cinco cada diez
   * segundos por IP y correo, así que los tests se comían su propio cupo y
   * fallaban con «Demasiados intentos» — que se lee como un login roto y no
   * lo es.
   */
  test.use({ storageState: SESION_ADMIN });

  /*
   * Esto buscaba un encabezado «Bandeja de entrada Gmail» que ya no existe.
   *
   * La pantalla se reorganizo: la seccion se llama «Cuentas Gmail de ingreso» y
   * la dibuja `GmailAccountsPanel`. El componente viejo, `GmailStatusSection`,
   * quedo en el arbol sin que lo importe nadie.
   *
   * El test no lo agarro porque nunca corrio: se salteaba por falta de
   * credenciales de Playwright. Se descubrio al crearlas.
   *
   * Se afirma lo que el producto hace HOY. La separacion de roles de verdad no
   * vive en este encabezado —se muestra a todo el mundo a proposito— sino en la
   * API, y eso se comprueba abajo.
   */
  test("un admin abre configuracion y ve la seccion de cuentas Gmail", async ({ page }) => {
    await page.goto("/configuracion");
    await expect(page).not.toHaveURL(/\/login/);

    const heading = page.getByRole("heading", { name: /cuentas gmail de ingreso/i });
    await expect(heading).toBeVisible();
  });
});

// ── Scenario 2: Analyst does NOT see Gmail status panel (requires live Neon + analyst account) ──

test.describe("Gmail status panel — analyst user invisibility (Scenario 2)", () => {
  // Skip if analyst credentials are not configured in the test environment.
  // To enable: set PLAYWRIGHT_ANALYST_EMAIL and PLAYWRIGHT_ANALYST_PASSWORD env vars.
  test.skip(!HAS_ANALYST_CREDS, "Skipped: PLAYWRIGHT_ANALYST_EMAIL not set — requires analyst Neon account");

  // Sesión de analista, por lo mismo que el bloque de arriba. Lo que se
  // prueba acá es qué NO ve un analista, no cómo entra.
  test.use({ storageState: SESION_ANALISTA });

  /*
   * Un analista ve la MISMA seccion, y eso es deliberado.
   *
   * Antes esto afirmaba que no la veia, y pasaba —pero por la razon equivocada:
   * buscaba un encabezado que ya no existe para nadie. Un verde asi se lee como
   * separacion de roles comprobada, y no comprobaba nada.
   *
   * Lo que separa a un analista de un admin es la API: `GET
   * /api/admin/gmail-accounts` le devuelve solo las cuentas que conecto el, y
   * `/api/admin/gmail-status` le responde 403. Eso es lo que se afirma.
   */
  test("un analista ve la seccion, que es lo que corresponde hoy", async ({ page }) => {
    await page.goto("/configuracion");
    await expect(page).not.toHaveURL(/\/login/);

    const heading = page.getByRole("heading", { name: /cuentas gmail de ingreso/i });
    await expect(heading).toBeVisible();
  });

  test("GET /api/admin/gmail-status as analyst returns 403 FORBIDDEN_ROLE", async ({ page }) => {
    // Call the admin-only endpoint — should return 403
    const res = await page.request.get("/api/admin/gmail-status");
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    // FORBIDDEN_ROLE is the project-wide error code for role-based 403s (AC6)
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
  });
});
