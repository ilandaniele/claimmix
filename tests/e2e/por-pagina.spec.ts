/**
 * Cien por página tiene que sostenerse, y la página no tiene que scrollear.
 *
 * Reportado como «si selecciono 100 no anda y se rompe». La capa de datos y el
 * hook que escribe `?per_page=100&page=1` estaban bien —medidos contra
 * staging—; lo que se rompía era visual: a 100 filas aparecía el scroll y
 * peleaban tres contenedores anidados. Este test afirma las dos cosas que
 * tienen que ser verdad después: que el tamaño elegido llega al selector, y
 * que scrollea la LISTA, no la página.
 *
 * Staging tiene un solo caso, así que no se pueden contar cien filas acá. Lo
 * que sí se puede es que el cableado sostenga el 100 y que haya un único
 * scroller, que es exactamente la parte que fallaba. Si el `max-h` de la tabla
 * volviera, `mainScrollea` vuelve a dar `true` y esto se pone rojo.
 */

import { test, expect } from "@playwright/test";
import { SESION_ADMIN } from "./sesiones";
import { enCualquierIdioma } from "./texto";

const HAY_ADMIN = !!(
  process.env.PLAYWRIGHT_ADMIN_EMAIL && process.env.PLAYWRIGHT_ADMIN_PASSWORD
);

test.describe("cien por página", () => {
  test.skip(!HAY_ADMIN, "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD");
  test.use({ storageState: SESION_ADMIN });

  test("el 100 llega al selector y scrollea la lista, no la página", async ({ page }) => {
    await page.goto("/bandeja?per_page=100");
    await expect(page).toHaveURL(/per_page=100/);

    const selector = page.getByRole("combobox", {
      name: enCualquierIdioma("pagination.perPage"),
    });
    await expect(selector).toHaveValue("100");

    const medida = await page.evaluate(() => {
      const main = document.querySelector("main");
      const listas = document.querySelectorAll('[data-scroll="lista"]');
      return {
        scrollers: listas.length,
        mainScrollea: main ? main.scrollHeight > main.clientHeight + 1 : null,
      };
    });
    expect(medida.scrollers).toBe(1);
    expect(medida.mainScrollea).toBe(false);
  });
});
