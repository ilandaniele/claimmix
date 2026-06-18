/**
 * E2E tests for analyst authentication flow.
 *
 * AC4: Analyst can sign in and reach /bandeja.
 *      Login page is in Spanish.
 *      Session persists; logout clears it.
 * AC2: Unauthenticated access to /bandeja redirects to /login.
 *
 * Requires:
 *   1. A running Next.js server (started by playwright webServer config).
 *   2. Valid test credentials in PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD.
 *
 * If credentials are not set, sign-in flow tests are skipped to avoid
 * false failures in CI without a Neon project.
 */

import { test, expect } from "@playwright/test";

const TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL ?? "lucia@seguros-del-sur.com.ar";
const TEST_PASSWORD = process.env.PLAYWRIGHT_TEST_PASSWORD ?? "Analyst123!";
const HAS_TEST_CREDS = !!(
  process.env.PLAYWRIGHT_TEST_EMAIL && process.env.PLAYWRIGHT_TEST_PASSWORD
);

test.describe("Login page — Spanish UI (AC4)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("login page renders in Spanish", async ({ page }) => {
    await expect(page).toHaveTitle(/ClaimMix/);
    await expect(page.getByRole("heading", { name: "Iniciar sesión" })).toBeVisible();
    await expect(page.getByLabel("Correo electrónico")).toBeVisible();
    await expect(page.getByLabel("Contraseña")).toBeVisible();
    await expect(page.getByRole("button", { name: "Iniciar sesión" })).toBeVisible();
  });

  test("login page shows ClaimMix brand", async ({ page }) => {
    await expect(page.getByText("ClaimMix")).toBeVisible();
    await expect(
      page.getByText("Gestión de siniestros asistida por IA")
    ).toBeVisible();
  });

  test("form has accessible labels", async ({ page }) => {
    const emailInput = page.getByLabel("Correo electrónico");
    const passwordInput = page.getByLabel("Contraseña");

    await expect(emailInput).toHaveAttribute("type", "email");
    await expect(emailInput).toHaveAttribute("autocomplete", "email");
    await expect(passwordInput).toHaveAttribute("type", "password");
  });

  test("shows validation error for invalid email", async ({ page }) => {
    await page.fill('[name="email"]', "not-an-email");
    await page.fill('[name="password"]', "somepassword");
    await page.click('[type="submit"]');

    // HTML5 validation or server-side error.
    // The browser may prevent submission with native validation.
    // Check the email field is invalid.
    const emailInput = page.locator('[name="email"]');
    const isInvalid =
      (await emailInput.getAttribute("aria-invalid")) === "true" ||
      (await emailInput.evaluate((el: HTMLInputElement) => !el.validity.valid));
    expect(isInvalid).toBe(true);
  });
});

test.describe("Auth redirect guard (AC2)", () => {
  test("unauthenticated access to /bandeja redirects to /login", async ({
    page,
  }) => {
    await page.goto("/bandeja");
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated access to / redirects to /login", async ({ page }) => {
    await page.goto("/");
    // Root may redirect to /bandeja then to /login, or directly to /login.
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe.configure({ mode: "serial" });

test.describe("Sign-in flow (AC4) — requires Neon credentials", () => {
  test.skip(!HAS_TEST_CREDS, "Skipped: PLAYWRIGHT_TEST_EMAIL not set");

  test("analyst can sign in with valid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.fill('[name="email"]', TEST_EMAIL);
    await page.fill('[name="password"]', TEST_PASSWORD);

    await Promise.all([
      page.waitForURL(/\/bandeja/),
      page.click('[type="submit"]'),
    ]);

    await expect(page).toHaveURL(/\/bandeja/);
  });

  test("authenticated user is redirected away from /login", async ({ page }) => {
    // Sign in first.
    await page.goto("/login");
    await page.fill('[name="email"]', TEST_EMAIL);
    await page.fill('[name="password"]', TEST_PASSWORD);
    await page.click('[type="submit"]');
    await page.waitForURL(/\/bandeja/);

    // Try to visit /login again — should redirect to /bandeja.
    await page.goto("/login");
    await expect(page).toHaveURL(/\/bandeja/);
  });

  test("analyst can sign out and is redirected to /login", async ({ page }) => {
    // Sign in.
    await page.goto("/login");
    await page.fill('[name="email"]', TEST_EMAIL);
    await page.fill('[name="password"]', TEST_PASSWORD);
    await page.click('[type="submit"]');
    await page.waitForURL(/\/bandeja/);

    // Sign out via the API.
    const response = await page.request.post("/api/auth/sign-out");
    expect(response.status()).toBe(204);

    // After sign-out, /bandeja should redirect to /login.
    await page.goto("/bandeja");
    await expect(page).toHaveURL(/\/login/);
  });

  test("invalid credentials show Spanish error message", async ({ page }) => {
    await page.goto("/login");
    await page.fill('[name="email"]', TEST_EMAIL);
    await page.fill('[name="password"]', "wrongpassword!");
    await page.click('[type="submit"]');

    const errorAlert = page.getByRole("alert");
    await expect(errorAlert).toBeVisible();
    const text = await errorAlert.textContent();
    expect(text).toBeTruthy();
    // Error should be in Spanish — not an English error message.
    expect(text).not.toMatch(/invalid|error|failed/i);
  });
});
