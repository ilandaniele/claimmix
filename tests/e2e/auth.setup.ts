/**
 * Iniciar sesión una vez, y que el resto de los tests reusen esa sesión.
 *
 * Cada test que necesitaba estar autenticado se logueaba de cero en su propio
 * `beforeEach`. Con catorce tests eso son nueve inicios de sesión seguidos
 * contra la misma cuenta, y el login tiene límite de tráfico: cinco intentos
 * cada diez segundos por IP y correo. Los tests se comían su propio cupo y
 * fallaban con «Demasiados intentos. Intente en 4 segundos.», que en el reporte
 * se lee como si el login estuviera roto.
 *
 * La tentación es aflojar el límite para los tests. Sería exactamente al revés:
 * el límite es la defensa contra el rociado de contraseñas, y un test que sólo
 * pasa con la defensa apagada no prueba el producto que se despliega.
 *
 * Lo que sí corresponde es no loguearse nueve veces. Playwright guarda el estado
 * del navegador —las cookies de sesión— en un archivo, y los tests lo levantan.
 * Se entra dos veces en total, una por rol, y de paso la suite corre más rápido.
 *
 * Los que SÍ prueban el login siguen entrando de verdad, con su propia cuenta
 * para no compartir cupo con esto. Ver `auth.spec.ts`.
 */
import { test as setup, expect } from "@playwright/test";

import { SESION_ANALISTA, SESION_ADMIN } from "./sesiones";

const ANALISTA_EMAIL = process.env.PLAYWRIGHT_TEST_EMAIL;
const ANALISTA_CLAVE = process.env.PLAYWRIGHT_TEST_PASSWORD;
const ADMIN_EMAIL = process.env.PLAYWRIGHT_ADMIN_EMAIL;
const ADMIN_CLAVE = process.env.PLAYWRIGHT_ADMIN_PASSWORD;

/**
 * Entra por la pantalla de verdad y guarda las cookies.
 *
 * Por la pantalla y no por la API a propósito: si el formulario de login se
 * rompe, esto tiene que romperse también. Una sesión fabricada por atrás haría
 * pasar toda la suite con el login caído.
 */
async function guardarSesion(
  page: import("@playwright/test").Page,
  correo: string,
  clave: string,
  destino: string
) {
  await page.goto("/login");
  await page.fill('[name="email"]', correo);
  await page.fill('[name="password"]', clave);
  await Promise.all([page.waitForURL(/\/bandeja/), page.click('[type="submit"]')]);

  // Que la sesión sirva, no sólo que la URL haya cambiado.
  await expect(page).toHaveURL(/\/bandeja/);
  await page.context().storageState({ path: destino });
}

setup("sesión de analista", async ({ page }) => {
  setup.skip(
    !ANALISTA_EMAIL || !ANALISTA_CLAVE,
    "Falta PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD"
  );
  await guardarSesion(page, ANALISTA_EMAIL!, ANALISTA_CLAVE!, SESION_ANALISTA);
});

setup("sesión de admin", async ({ page }) => {
  setup.skip(
    !ADMIN_EMAIL || !ADMIN_CLAVE,
    "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD"
  );
  await guardarSesion(page, ADMIN_EMAIL!, ADMIN_CLAVE!, SESION_ADMIN);
});
