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

/*
 * Éste es el único archivo que se loguea de verdad, y usa su propia cuenta.
 *
 * El login limita a cinco intentos cada diez segundos por IP y correo. Es la
 * defensa contra el rociado de contraseñas y no se toca: un test que sólo pasa
 * con la defensa apagada no prueba el producto que se despliega.
 *
 * Pero eso significa que hay un cupo compartido, y estos cuatro tests lo gastan
 * entre todos: tres entradas válidas y una inválida. El resto de la suite ya no
 * se loguea —reusa la sesión que guarda `auth.setup.ts`— así que alcanza con que
 * este archivo tenga un correo propio para no compartir cupo con el sembrado de
 * esa sesión.
 *
 * Cae de vuelta a PLAYWRIGHT_TEST_* para que siga andando donde haya una sola
 * cuenta configurada; ahí los cuatro entran igual, sólo que más justo.
 */
const TEST_EMAIL =
  process.env.PLAYWRIGHT_ANALYST_EMAIL ??
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  "lucia@seguros-del-sur.com.ar";
const TEST_PASSWORD =
  process.env.PLAYWRIGHT_ANALYST_PASSWORD ??
  process.env.PLAYWRIGHT_TEST_PASSWORD ??
  "Analyst123!";
const HAS_TEST_CREDS = !!(
  (process.env.PLAYWRIGHT_ANALYST_EMAIL ?? process.env.PLAYWRIGHT_TEST_EMAIL) &&
  (process.env.PLAYWRIGHT_ANALYST_PASSWORD ?? process.env.PLAYWRIGHT_TEST_PASSWORD)
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
    //
    // Con `Content-Type: application/json` y cuerpo vacio, que es lo que pide
    // Better Auth: sin la cabecera responde 415 y el test culpaba al cierre de
    // sesion por algo que era como se lo llamaba. Lo que se prueba aca es que
    // cerrar sesion funcione, no la negociacion de contenido.
    const response = await page.request.post("/api/auth/sign-out", {
      headers: {
        "Content-Type": "application/json",
        // Better Auth exige Origin: es su defensa contra CSRF. Sin la cabecera
        // responde 403, y el test culpaba al cierre de sesion por algo que era
        // como se lo llamaba.
        Origin: "http://localhost:3000",
      },
      data: {},
    });
    // Que haya salido bien, sin atarse al codigo exacto: esta version de Better
    // Auth responde 200 con cuerpo y el test esperaba 204. Lo que de verdad
    // prueba el cierre de sesion es la afirmacion de abajo — que despues de
    // esto una ruta privada mande al login.
    expect(response.ok()).toBe(true);

    // After sign-out, /bandeja should redirect to /login.
    await page.goto("/bandeja");
    await expect(page).toHaveURL(/\/login/);
  });

  test("invalid credentials show Spanish error message", async ({ page }) => {
    await page.goto("/login");
    await page.fill('[name="email"]', TEST_EMAIL);
    await page.fill('[name="password"]', "wrongpassword!");
    await page.click('[type="submit"]');

    // Acotado al formulario: la pantalla tiene mas de un elemento con rol
    // `alert`. El overlay de desarrollo de Next inyecta el suyo, vacio, y
    // `page.getByRole("alert")` a secas se quedaba con ese — el test fallaba
    // diciendo que el mensaje estaba vacio cuando el mensaje existia al lado.
    const errorAlert = page
      .getByRole("form", { name: /inicio de sesión/i })
      .getByRole("alert");
    await expect(errorAlert).toBeVisible();
    const text = await errorAlert.textContent();
    expect(text).toBeTruthy();
    // Error should be in Spanish — not an English error message.
    expect(text).not.toMatch(/invalid|error|failed/i);
  });
});
