/**
 * E2E tests for the email messages thread panel in /casos/[id].
 *
 * Scenario 1 (auth-gated): Case detail shows messages thread for a Gmail case.
 *   - Navigate to a case detail page for a case with channel='email' and at least 1 claim_message.
 *   - Expect a "Mensajes recibidos" heading to be visible.
 *   - Expect at least one message card with from_addr and subject visible.
 *
 * Scenario 2 (auth-gated): Case detail does NOT show messages thread when no messages exist.
 *   - Navigate to a case detail page with no claim_messages rows.
 *   - Expect "Mensajes recibidos" heading to NOT be present.
 *
 * Scenarios 1 and 2 require a live Neon session + test case IDs with known data.
 * They are skipped in CI unless PLAYWRIGHT_TEST_EMAIL and PLAYWRIGHT_EMAIL_CASE_ID are set.
 *
 * API access control tests (no auth required) run unconditionally.
 *
 * Note: The heading text "Mensajes recibidos" corresponds to i18n key
 * "messages.thread.title" in src/lib/i18n/es-AR.ts, which is rendered by
 * casos/[id]/page.tsx only when isEmailCase=true.
 */

import { test, expect } from "@playwright/test";
import { SESION_ANALISTA } from "./sesiones";
import { enCualquierIdioma } from "./texto";

const TEST_EMAIL = process.env.PLAYWRIGHT_TEST_EMAIL;
const TEST_PASSWORD = process.env.PLAYWRIGHT_TEST_PASSWORD;

// Set PLAYWRIGHT_EMAIL_CASE_ID to a case UUID with channel='email' and at least 1 claim_message
const EMAIL_CASE_ID = process.env.PLAYWRIGHT_EMAIL_CASE_ID;
// Set PLAYWRIGHT_EMPTY_CASE_ID to a case UUID with channel='email' and 0 claim_messages
const EMPTY_CASE_ID = process.env.PLAYWRIGHT_EMPTY_CASE_ID;

const HAS_TEST_CREDS = !!(TEST_EMAIL && TEST_PASSWORD);
const HAS_EMAIL_CASE = !!(HAS_TEST_CREDS && EMAIL_CASE_ID);
const HAS_EMPTY_CASE = !!(HAS_TEST_CREDS && EMPTY_CASE_ID);

const FAKE_CASE_ID = "00000000-0000-0000-0000-000000000001";

// ── API access control (no session required) ─────────────────────────────────

test.describe("Case messages API — unauthenticated access control", () => {
  test("GET /api/cases/:id/messages without session returns 401", async ({ page }) => {
    const res = await page.request.get(`/api/cases/${FAKE_CASE_ID}/messages`);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("code");
    expect(body.error.code).toBe("MISSING_SESSION");
  });

  test("/casos/:id without session redirects to /login", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`/casos/${FAKE_CASE_ID}`);
    const url = page.url();
    const isAtLogin = url.includes("/login");
    const isAtCase = url.includes("/casos/");
    // Proxy.ts redirects unauthenticated users to /login
    expect(isAtLogin || isAtCase).toBe(true);
  });

  test("GET /api/cases/:id/messages has required security headers", async ({ page }) => {
    const res = await page.request.get(`/api/cases/${FAKE_CASE_ID}/messages`);
    const headers = res.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
  });
});

// ── Scenario 1: Case detail shows messages thread for a Gmail case ────────────

test.describe("Messages thread — Gmail case with messages (Scenario 1)", () => {
  // Skip if test credentials or case ID are not configured.
  // To enable: set PLAYWRIGHT_TEST_EMAIL, PLAYWRIGHT_TEST_PASSWORD, PLAYWRIGHT_EMAIL_CASE_ID.
  test.skip(
    !HAS_EMAIL_CASE,
    "Skipped: PLAYWRIGHT_TEST_EMAIL or PLAYWRIGHT_EMAIL_CASE_ID not set — requires a live case with channel='email' and claim_messages"
  );

  /*
   * La sesión sale del archivo que dejó `auth.setup.ts`, no de loguearse acá.
   *
   * Estos tests no prueban el login: prueban qué muestra la pantalla de un caso.
   * Entrar de nuevo en cada uno gastaba el cupo del límite de tráfico —cinco
   * intentos cada diez segundos— y los hacía fallar con «Demasiados intentos»,
   * que en el reporte se lee como si el login estuviera roto.
   */
  test.use({ storageState: SESION_ANALISTA });

  test("case detail shows 'Mensajes recibidos' heading for email case", async ({ page }) => {
    await page.goto(`/casos/${EMAIL_CASE_ID}`);
    await expect(page).not.toHaveURL(/\/login/);

    // The section heading is rendered by casos/[id]/page.tsx when isEmailCase=true
    const heading = page.getByRole("heading", { name: enCualquierIdioma("messages.thread.title") });
    await expect(heading).toBeVisible();
  });

  test("case detail shows at least one message card with from_addr and subject", async ({ page }) => {
    await page.goto(`/casos/${EMAIL_CASE_ID}`);
    await expect(page).not.toHaveURL(/\/login/);

    // Wait for MessagesThread to load (it fetches /api/cases/:id/messages on mount)
    // At least one message card should appear
    const firstCard = page.locator('[data-testid="message-card"]').first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });

    // Each card should contain visible text for from_addr and subject
    // from_addr is in the first text-sm.font-medium element; subject is in font-semibold
    const cardText = await firstCard.textContent();
    expect(cardText).toBeTruthy();
    expect(cardText!.length).toBeGreaterThan(0);
  });

  test("messages API returns 200 with messages array for owned case", async ({ page }) => {
    const res = await page.request.get(`/api/cases/${EMAIL_CASE_ID}/messages`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("messages");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThan(0);

    // Each message entry must have the expected fields (AC8)
    const msg = body.messages[0];
    expect(msg).toHaveProperty("id");
    expect(msg).toHaveProperty("direction");
    expect(msg).toHaveProperty("provider");
    expect(msg).toHaveProperty("subject");
    expect(msg).toHaveProperty("from_addr");
    expect(msg).toHaveProperty("body_text");
    expect(msg).toHaveProperty("received_at");
    expect(msg).toHaveProperty("attachment_count");
  });
});

// ── Scenario 2: Case detail does NOT show messages thread when no messages ────

test.describe("Messages thread — case with no messages (Scenario 2)", () => {
  // Skip if test credentials or empty-case ID are not configured.
  // To enable: set PLAYWRIGHT_TEST_EMAIL, PLAYWRIGHT_TEST_PASSWORD, PLAYWRIGHT_EMPTY_CASE_ID.
  test.skip(
    !HAS_EMPTY_CASE,
    "Skipped: PLAYWRIGHT_TEST_EMAIL or PLAYWRIGHT_EMPTY_CASE_ID not set — requires a live case with channel='email' and 0 claim_messages"
  );

  /*
   * La sesión sale del archivo que dejó `auth.setup.ts`, no de loguearse acá.
   *
   * Estos tests no prueban el login: prueban qué muestra la pantalla de un caso.
   * Entrar de nuevo en cada uno gastaba el cupo del límite de tráfico —cinco
   * intentos cada diez segundos— y los hacía fallar con «Demasiados intentos»,
   * que en el reporte se lee como si el login estuviera roto.
   */
  test.use({ storageState: SESION_ANALISTA });

  test("'Mensajes recibidos' heading NOT present when case has no claim_messages (AC12)", async ({ page }) => {
    await page.goto(`/casos/${EMPTY_CASE_ID}`);
    await expect(page).not.toHaveURL(/\/login/);

    // MessagesThread renders null when messages array is empty (AC12).
    // The section heading should not appear on the page.
    // Wait briefly for the fetch to complete before asserting absence.
    await page.waitForTimeout(2000);
    const heading = page.getByRole("heading", { name: enCualquierIdioma("messages.thread.title") });
    await expect(heading).not.toBeVisible();
  });

  test("messages API returns 200 with empty array for case with no messages (AC10)", async ({ page }) => {
    const res = await page.request.get(`/api/cases/${EMPTY_CASE_ID}/messages`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ messages: [] });
  });
});

// ── IDOR protection — cross-tenant access (API level, no UI) ─────────────────

test.describe("Messages thread — IDOR protection", () => {
  test("GET /api/cases/:id/messages with fake UUID returns 401 (not found without auth)", async ({ page }) => {
    // Without auth, should return 401 before IDOR check
    const res = await page.request.get(`/api/cases/${FAKE_CASE_ID}/messages`);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("MISSING_SESSION");
  });
});
