/**
 * El asistente (P9): quién entra a `/asistente`.
 *
 * Plan Pro se resuelve del lado del servidor, así que un test de unidad no ve
 * la redirección ni el bloqueo. Lo que se prueba acá es la guarda de sesión —
 * igual para cualquier plan— y que la pantalla pinta, no la conversación con
 * el modelo: eso está en `responder.test.ts`, mockeado.
 *
 * No se asume el plan del tenant de prueba: con o sin Plan Pro la página
 * muestra el mismo título, arriba de `CajaDelAsistente` o de `BloqueoPlanPro`.
 */
import { test, expect } from "@playwright/test";
import { SESION_ANALISTA } from "./sesiones";
import { enCualquierIdioma } from "./texto";

const ANALYST_EMAIL = process.env.PLAYWRIGHT_TEST_EMAIL;
const ANALYST_PASSWORD = process.env.PLAYWRIGHT_TEST_PASSWORD;
const HAY_ANALISTA = !!(ANALYST_EMAIL && ANALYST_PASSWORD);

test.describe("asistente sin sesión", () => {
  test("una visita anónima a /asistente termina en el login", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto("/asistente");

    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: enCualquierIdioma("asistente.titulo") })
    ).not.toBeVisible();
  });
});

test.describe("asistente con sesión", () => {
  test.skip(!HAY_ANALISTA, "Falta PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD");
  test.use({ storageState: SESION_ANALISTA });

  test("la pantalla abre, con o sin Plan Pro", async ({ page }) => {
    await page.goto("/asistente");
    await expect(page).not.toHaveURL(/\/login/);

    await expect(
      page.getByRole("heading", { name: enCualquierIdioma("asistente.titulo") })
    ).toBeVisible();
  });
});
