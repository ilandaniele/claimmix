/**
 * La interfaz con la cuenta en inglés.
 *
 * Todo el resto de la suite mira los textos con `enCualquierIdioma`, que acepta
 * el castellano o el inglés porque `users.locale` es estado de cada cuenta en el
 * ambiente compartido. Por eso nada avisaba si una pantalla dejaba un literal en
 * castellano o pedía mal la clave en inglés: el verde era el mismo.
 *
 * Acá la cuenta del analista pasa a en-US por la misma ruta que usa el
 * selector de idioma, se mira que las pantallas digan EXACTAMENTE el texto del
 * diccionario en inglés, y al terminar cada test la cuenta vuelve a como estaba.
 *
 * Sin casos sembrados: sólo hace falta la sesión que deja `auth.setup.ts`, que
 * se saltea sola si no hay credenciales configuradas.
 */

import { test, expect, type Page } from "@playwright/test";

import { enUS, esAR } from "../../src/lib/i18n/index";
import { SESION_ANALISTA } from "./sesiones";

const ANALYST_EMAIL = process.env.PLAYWRIGHT_ANALYST_EMAIL ?? process.env.PLAYWRIGHT_TEST_EMAIL;
const ANALYST_PASSWORD =
  process.env.PLAYWRIGHT_ANALYST_PASSWORD ?? process.env.PLAYWRIGHT_TEST_PASSWORD;

/**
 * El PATCH olvida la fila cacheada sólo en su propia copia del módulo: el layout
 * puede tener otra y servir el idioma anterior hasta que vence `TTL_FILA_MS`
 * (30 s, `fila-de-usuario-cacheada.ts`). Se reintenta hasta pasar ese plazo.
 */
async function abrirEnIngles(page: Page, ruta: string) {
  await expect(async () => {
    await page.goto(ruta);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("navigation", { name: enUS["nav.principal"], exact: true })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 40_000, intervals: [2_000] });
}

test.describe("con la cuenta en en-US", () => {
  test.skip(!(ANALYST_EMAIL && ANALYST_PASSWORD), "Falta PLAYWRIGHT_ANALYST_EMAIL / PLAYWRIGHT_ANALYST_PASSWORD");

  // Un solo archivo cambia el idioma de una cuenta compartida: en serie, para no pisarse a sí mismo.
  test.describe.configure({ mode: "serial", timeout: 60_000 });
  test.use({ storageState: SESION_ANALISTA });

  let idiomaOriginal: "es-AR" | "en-US" | null = null;

  test.beforeEach(async ({ request }) => {
    const yo = await request.get("/api/auth/me");
    expect(yo.ok()).toBe(true);
    idiomaOriginal = ((await yo.json()) as { locale: "es-AR" | "en-US" | null }).locale;

    const res = await request.patch("/api/auth/me", { data: { locale: "en-US" } });
    expect(res.ok()).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    // La ruta no acepta «sin preferencia»: sin una guardada, el castellano es lo que ya se veía.
    await request.patch("/api/auth/me", { data: { locale: idiomaOriginal ?? "es-AR" } });
  });

  test("la bandeja se ve en inglés y el documento lo declara", async ({ page }) => {
    await abrirEnIngles(page, "/bandeja");

    await expect(page.getByRole("navigation", { name: esAR["nav.principal"], exact: true })).toHaveCount(0);
    await expect(page.locator('[lang="en-US"]').first()).toBeAttached();
  });

  test("configuración se ve en inglés, con el título de la pestaña", async ({ page }) => {
    await abrirEnIngles(page, "/configuracion");

    await expect(page).toHaveTitle(`${enUS["nav.configuracion"]} — ClaimMix`);
    await expect(page.getByRole("heading", { name: enUS["configuracion.title"], exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: enUS["gmail.accounts.title"], exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: esAR["gmail.accounts.title"], exact: true })).toHaveCount(0);
  });
});
