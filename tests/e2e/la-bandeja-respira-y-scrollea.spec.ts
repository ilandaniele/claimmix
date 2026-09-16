/**
 * La bandeja tiene aire abajo y se puede llegar a sus últimas columnas.
 *
 * Tres cosas que se rompieron juntas y que sólo se ven mirando la pantalla a
 * un ancho de portátil, que es donde se usa el producto: la tarjeta terminaba
 * pegada al borde inferior de la ventana; la tabla, sin un ancho mínimo,
 * estrujaba sus últimas columnas hasta volverlas ilegibles; y no había ninguna
 * barra para correrla al costado, así que lo estrujado no tenía remedio.
 *
 * El test mide, no mira: el hueco en píxeles bajo el paginador, y que el
 * contenedor de la lista tenga de verdad a dónde scrollear. Una captura no
 * habría servido — lo que falla acá es aritmética de layout.
 */

import { test, expect } from "@playwright/test";
import { SESION_ANALISTA } from "./sesiones";

const HAY_ANALISTA = !!(
  process.env.PLAYWRIGHT_TEST_EMAIL && process.env.PLAYWRIGHT_TEST_PASSWORD
);

/** El ancho donde el usuario reportó el corte: un portátil, no un monitor. */
const ANCHO_PORTATIL = { width: 1280, height: 800 };

test.describe("la bandeja a ancho de portátil", () => {
  test.skip(!HAY_ANALISTA, "Falta PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD");
  test.use({ storageState: SESION_ANALISTA, viewport: ANCHO_PORTATIL });

  test("deja aire entre la tarjeta y el borde de abajo", async ({ page }) => {
    await page.goto("/bandeja");
    const lista = page.locator('[data-scroll="lista"]');
    await expect(lista).toBeVisible();

    const hueco = await page.evaluate(() => {
      const scroller = document.querySelector('[data-scroll="lista"]');
      const tarjeta = scroller?.closest("div.flex.h-full.flex-col");
      if (!tarjeta) return null;
      return Math.round(window.innerHeight - tarjeta.getBoundingClientRect().bottom);
    });

    expect(hueco, "no encontré la tarjeta de la lista").not.toBeNull();
    // 24 px era lo que había y se leía pegado. Con 32 se despega; el techo
    // está para que nadie lo convierta en un margen que se come la lista.
    expect(hueco!).toBeGreaterThanOrEqual(28);
    expect(hueco!).toBeLessThanOrEqual(64);
  });

  test("y se puede correr la tabla para ver las últimas columnas", async ({ page }) => {
    await page.goto("/bandeja");
    const lista = page.locator('[data-scroll="lista"]');
    await expect(lista).toBeVisible();
    // Sin filas no hay tabla que correr, y el tenant de pruebas podría no
    // tener ninguna: eso no es este defecto.
    test.skip((await page.locator('[data-scroll="lista"] tbody tr').count()) === 0, "sin casos");

    const medidas = await lista.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
    }));

    expect(medidas.overflowX, "el contenedor tiene que poder scrollear").toBe("auto");
    expect(
      medidas.scrollWidth,
      "la tabla no tiene ancho mínimo: se estruja en vez de ofrecer barra"
    ).toBeGreaterThan(medidas.clientWidth);

    // Y que la barra LLEVE a algún lado: pedirla y que no se mueva sería el
    // mismo defecto con otra forma.
    await lista.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    expect(await lista.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  });
});
