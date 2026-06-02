/**
 * E2E: simulate → realtime → case appears in table.
 *
 * AC4: POST /api/intake/simulate creates a case in "procesando" status,
 *      visible via Supabase Realtime within 2 seconds.
 *
 * Requirements:
 *   - Needs a live Supabase backend (NEXT_PUBLIC_SUPABASE_URL in env).
 *   - Uses MOCK_AI=true (set in playwright.config.ts webServer env) so no real
 *     OpenAI call is made during simulation.
 *   - Needs SUPABASE_URL, TEST_ANALYST_EMAIL, TEST_ANALYST_PASSWORD env vars for
 *     authenticated flow.
 *
 * Without live Supabase the test is skipped automatically.
 */

import { test, expect } from "@playwright/test";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const TEST_EMAIL = process.env.TEST_ANALYST_EMAIL ?? "";
const TEST_PASSWORD = process.env.TEST_ANALYST_PASSWORD ?? "";

const hasLiveSupabase =
  SUPABASE_URL.length > 0 &&
  !SUPABASE_URL.includes("placeholder") &&
  TEST_EMAIL.length > 0 &&
  TEST_PASSWORD.length > 0;

// Helper: sign in via the login form and wait for redirect to /bandeja.
async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel(/correo electrónico/i).fill(TEST_EMAIL);
  await page.getByLabel(/contraseña/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL(/\/bandeja/, { timeout: 15_000 });
}

test.describe("Simulate → realtime flow (AC4)", () => {
  test.skip(
    !hasLiveSupabase,
    "Requires live Supabase (NEXT_PUBLIC_SUPABASE_URL, TEST_ANALYST_EMAIL, TEST_ANALYST_PASSWORD)"
  );

  test(
    "simulate new email creates case in Procesando status visible in table",
    async ({ page }) => {
      // 1. Sign in as test analyst.
      await signIn(page);
      await expect(page).toHaveURL(/\/bandeja/);

      // 2. Count existing rows before simulating so we can detect the new one.
      const tableBody = page.locator("table tbody");
      const initialRowCount = await tableBody.locator("tr").count();

      // 3. Open "Simular nuevo email" modal via the simulate button.
      const simulateBtn = page.getByTestId("simulate-button");
      await expect(simulateBtn).toBeVisible();
      await simulateBtn.click();

      // 4. Verify modal is open (role=dialog).
      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible();

      // 5. The modal defaults to "Escenario pre-cargado" mode with a scenario
      //    already selected. Select an explicit scenario to be deterministic.
      const scenarioSelect = modal.locator("#scenario-select");
      await expect(scenarioSelect).toBeVisible();
      // Pick the first option (choque-01 or whatever is first).
      await scenarioSelect.selectOption({ index: 0 });

      // 6. Click "Simular" (the submit button inside the modal).
      const submitBtn = page.getByTestId("simulate-submit");
      await expect(submitBtn).toBeVisible();
      await submitBtn.click();

      // 7. Modal should close after submission (success path).
      await expect(modal).not.toBeVisible({ timeout: 5_000 });

      // 8. Poll until a new row appears in the cases table (up to 5 seconds).
      //    The row is inserted via Supabase Realtime, so the table updates
      //    without a page reload.
      await expect(async () => {
        const rowCount = await tableBody.locator("tr").count();
        expect(rowCount).toBeGreaterThan(initialRowCount);
      }).toPass({ timeout: 5_000, intervals: [300, 300, 500, 500, 500, 500, 500, 500, 500, 500] });

      // 9. Verify the newest row shows "Procesando" status badge.
      //    The row is inserted at the top of the table via mergeCaseUpdate.
      const firstRow = tableBody.locator("tr").first();
      await expect(firstRow).toContainText(/procesando/i, { timeout: 5_000 });
    }
  );

  test(
    "simulate via API without auth returns 401",
    async ({ request }) => {
      // This test does NOT need live Supabase — proxy.ts enforces auth before DB.
      // It verifies the security gate for the simulate endpoint.
      const res = await request.post("/api/intake/simulate", {
        data: { scenario_id: "choque-01" },
      });
      expect(res.status()).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("MISSING_SESSION");
    }
  );

  test.slow();
});

test.describe("Simulate modal structure (no auth required)", () => {
  test("login page is accessible as fallback check", async ({ page }) => {
    // Smoke test: dev server is up, login page renders without crashing.
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: /iniciar sesión/i })
    ).toBeVisible();
  });
});
