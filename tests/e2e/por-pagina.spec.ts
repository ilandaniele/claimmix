/**
 * Cien por página tiene que MOSTRAR cien filas, y la página no tiene que
 * scrollear.
 *
 * La primera versión de este test afirmaba que el selector decía «100» y que
 * había un solo scroller — y pasaba. Pero nunca contó filas, porque el tenant
 * contra el que corría tenía un caso. Con eso en verde se reportó igual: «pongo
 * 100, el pie dice 1-100, la tabla sigue en 20». Un test que no mira lo que
 * el usuario mira no prueba lo que el usuario ve.
 *
 * Ahora cuenta `tbody tr` contra el total que el pie declara, en los dos
 * tamaños. Vale para cualquier tenant: si hay menos casos que el tamaño de
 * página, espera el total; si hay más, espera el tamaño.
 */

import { test, expect, type Page } from "@playwright/test";
import { SESION_ADMIN } from "./sesiones";
import { enCualquierIdioma } from "./texto";

const HAY_ADMIN = !!(
  process.env.PLAYWRIGHT_ADMIN_EMAIL && process.env.PLAYWRIGHT_ADMIN_PASSWORD
);

/** El total que el pie declara: «Mostrando 1-100 de 261 siniestros» → 261. */
async function totalDelPie(page: Page): Promise<number> {
  const texto = await page.getByText(/\b\d+-\d+\s+\S+\s+\d+\b/).first().innerText();
  const m = texto.match(/\d+-\d+\s+\S+\s+(\d+)/);
  if (!m) throw new Error(`no pude leer el total del pie: ${JSON.stringify(texto)}`);
  return Number(m[1]);
}

async function filas(page: Page): Promise<number> {
  return page.locator('[data-scroll="lista"] tbody tr').count();
}

test.describe("cien por página", () => {
  test.skip(!HAY_ADMIN, "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD");
  test.use({ storageState: SESION_ADMIN });

  test("a 100 por página la tabla muestra 100 filas, no 20", async ({ page }) => {
    await page.goto("/bandeja?per_page=100");
    await expect(page).toHaveURL(/per_page=100/);

    const selector = page.getByRole("combobox", {
      name: enCualquierIdioma("pagination.perPage"),
    });
    await expect(selector).toHaveValue("100");

    const total = await totalDelPie(page);
    await expect.poll(() => filas(page), { timeout: 10_000 }).toBe(Math.min(100, total));
  });

  test("el tamaño por omisión muestra 20", async ({ page }) => {
    await page.goto("/bandeja");
    const total = await totalDelPie(page);
    await expect.poll(() => filas(page), { timeout: 10_000 }).toBe(Math.min(20, total));
  });

  test("cambiar el selector en la pantalla cambia las filas", async ({ page }) => {
    // El camino real del usuario: no la URL, el desplegable.
    await page.goto("/bandeja");
    const total = await totalDelPie(page);
    test.skip(total <= 20, "hacen falta más de 20 casos para distinguir 20 de 100");

    const selector = page.getByRole("combobox", {
      name: enCualquierIdioma("pagination.perPage"),
    });
    await selector.selectOption("100");
    await expect(page).toHaveURL(/per_page=100/);
    await expect.poll(() => filas(page), { timeout: 10_000 }).toBe(Math.min(100, total));
  });

  test("scrollea la lista, no la página", async ({ page }) => {
    await page.goto("/bandeja?per_page=100");
    const medida = await page.evaluate(() => {
      const main = document.querySelector("main");
      return {
        scrollers: document.querySelectorAll('[data-scroll="lista"]').length,
        mainScrollea: main ? main.scrollHeight > main.clientHeight + 1 : null,
      };
    });
    expect(medida.scrollers).toBe(1);
    expect(medida.mainScrollea).toBe(false);
  });
});
