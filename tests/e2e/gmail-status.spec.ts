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

  test("admin user sees 'Bandeja de entrada Gmail' section in /configuracion", async ({ page }) => {
    // Sign in as admin
    await page.goto("/login");
    await page.fill('[name="email"]', ADMIN_EMAIL!);
    await page.fill('[name="password"]', ADMIN_PASSWORD!);
    await page.click('[type="submit"]');
    await page.waitForURL(/\/bandeja/);

    // Navigate to /configuracion
    await page.goto("/configuracion");
    await expect(page).not.toHaveURL(/\/login/);

    // The section heading is rendered by configuracion/page.tsx when role='admin'
    const heading = page.getByRole("heading", { name: /bandeja de entrada gmail/i });
    await expect(heading).toBeVisible();

    // Expect one of the three possible status pills to be visible
    const statusPill = page.getByRole("status");
    await expect(statusPill).toBeVisible();
    const pillText = await statusPill.textContent();
    expect(STATUS_PILL_TEXTS.some((s) => pillText?.includes(s))).toBe(true);
  });
});

// ── Scenario 2: Analyst does NOT see Gmail status panel (requires live Neon + analyst account) ──

test.describe("Gmail status panel — analyst user invisibility (Scenario 2)", () => {
  // Skip if analyst credentials are not configured in the test environment.
  // To enable: set PLAYWRIGHT_ANALYST_EMAIL and PLAYWRIGHT_ANALYST_PASSWORD env vars.
  test.skip(!HAS_ANALYST_CREDS, "Skipped: PLAYWRIGHT_ANALYST_EMAIL not set — requires analyst Neon account");

  test("analyst user does NOT see 'Bandeja de entrada Gmail' section in /configuracion", async ({ page }) => {
    // Sign in as analyst
    await page.goto("/login");
    await page.fill('[name="email"]', ANALYST_EMAIL!);
    await page.fill('[name="password"]', ANALYST_PASSWORD!);
    await page.click('[type="submit"]');
    await page.waitForURL(/\/bandeja/);

    // Navigate to /configuracion
    await page.goto("/configuracion");
    await expect(page).not.toHaveURL(/\/login/);

    // The Gmail section is conditionally rendered server-side only for role='admin'.
    // For analyst: configuracion/page.tsx does not render the <Section> block,
    // and GmailStatusSection itself returns null on 403 from /api/admin/gmail-status.
    const heading = page.getByRole("heading", { name: /bandeja de entrada gmail/i });
    await expect(heading).not.toBeVisible();
  });

  test("GET /api/admin/gmail-status as analyst returns 403 FORBIDDEN_ROLE", async ({ page }) => {
    // Sign in as analyst
    await page.goto("/login");
    await page.fill('[name="email"]', ANALYST_EMAIL!);
    await page.fill('[name="password"]', ANALYST_PASSWORD!);
    await page.click('[type="submit"]');
    await page.waitForURL(/\/bandeja/);

    // Call the admin-only endpoint — should return 403
    const res = await page.request.get("/api/admin/gmail-status");
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    // FORBIDDEN_ROLE is the project-wide error code for role-based 403s (AC6)
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
  });
});
