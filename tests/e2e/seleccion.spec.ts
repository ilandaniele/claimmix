/**
 * La selección de siniestros, sin recuadros.
 *
 * Reportado como «no me gustan los recuadros de seleccionar». Veinte casillas
 * cuadradas en cada fila para una acción de vez en cuando. Ahora la columna
 * existe sólo en modo selección —un botón «Seleccionar» en el encabezado—, el
 * control es un círculo del acento, y «seleccionar todos» es una acción con
 * su número, no una casilla en el encabezado.
 *
 * Lo que este test afirma es lo que se puede ver: fuera del modo no hay ningún
 * control de selección; «Seleccionar los N de esta página» marca N; «Listo»
 * sale del modo y no deja nada marcado.
 */

import { test, expect } from "@playwright/test";
import { SESION_ADMIN } from "./sesiones";
import { enCualquierIdioma } from "./texto";
import { filas } from "./bandeja";

const HAY_ADMIN = !!(
  process.env.PLAYWRIGHT_ADMIN_EMAIL && process.env.PLAYWRIGHT_ADMIN_PASSWORD
);

test.describe("selección sin recuadros", () => {
  test.skip(!HAY_ADMIN, "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD");
  test.use({ storageState: SESION_ADMIN });

  test("no hay casillas hasta entrar al modo; seleccionar todos marca la página; Listo limpia", async ({ page }) => {
    await page.goto("/bandeja");
    await expect(filas(page).first()).toBeVisible();
    const enPagina = await filas(page).count();

    // Fuera del modo: ni un control de selección en la tabla.
    await expect(page.getByRole("checkbox")).toHaveCount(0);

    await page.getByRole("button", { name: enCualquierIdioma("bandeja.seleccionar") }).click();

    // Al entrar, los círculos aparecen en el acto y vacíos. Antes el memo de
    // columnas no dependía del modo y la columna recién aparecía al tocar
    // otra cosa: «apreté Seleccionar y no selecciona».
    await expect(page.getByRole("checkbox")).toHaveCount(enPagina);
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);

    // Tocar el círculo marca esa fila, y sólo esa.
    await page.getByRole("checkbox").first().click();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(1);
    await expect(page).toHaveURL(/\/bandeja/);

    // «Seleccionar los N de esta página» dice cuántos y los marca todos.
    await page
      .getByRole("button", { name: new RegExp(`^(Seleccionar los ${enPagina}|Select all ${enPagina})`) })
      .click();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(enPagina);

    // Y se convierte en «Quitar selección» cuando ya están todas.
    await expect(
      page.getByRole("button", { name: enCualquierIdioma("bandeja.quitarSeleccion") })
    ).toBeVisible();

    await page.getByRole("button", { name: enCualquierIdioma("bandeja.listo") }).click();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  });

  /*
   * Lo marcado no sobrevive a lo que ya no está en pantalla. Antes el
   * conjunto de ids vivía en la tabla y nadie lo tocaba al cambiar de página
   * o de filtro: cero círculos marcados, el contador decía N, y «Eliminar
   * seleccionados (N)» mandaba a borrar filas que no se veían.
   */
  test("cambiar de página no deja nada marcado", async ({ page }) => {
    await page.goto("/bandeja");
    const siguiente = page.getByRole("button", {
      name: enCualquierIdioma("pagination.next", { exacto: true }),
    });
    test.skip(await siguiente.isDisabled(), "una sola página");

    // Antes de que exista la barra: su «Seleccionar los N» también matchea.
    await page.getByRole("button", { name: enCualquierIdioma("bandeja.seleccionar") }).click();
    const primera = await filas(page).first().getAttribute("aria-label");
    expect(primera).toMatch(/SIN-/);
    await page.getByRole("checkbox").first().click();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(1);

    await siguiente.click();
    await expect(page).toHaveURL(/page=2/, { timeout: 15_000 });
    // 20 == 20 no distingue páginas y la URL cambia un commit antes que la
    // data: la página 2 llegó cuando la primera fila es otra.
    await expect
      .poll(() => filas(page).first().getAttribute("aria-label"), { timeout: 10_000 })
      .not.toBe(primera);

    // El modo sigue prendido; lo marcado no.
    await expect(page.getByRole("checkbox")).toHaveCount(await filas(page).count());
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(
      page.getByRole("toolbar", { name: enCualquierIdioma("bandeja.seleccionar") }).locator(".cifra")
    ).toHaveText("0");
    await expect(
      page.getByRole("button", { name: enCualquierIdioma("bandeja.deleteSelected") })
    ).toHaveCount(0);
  });

  /*
   * Cambiar de pestaña también poda. Marcar la primera fila de «Todos» y mirar
   * «Listos» no pinzaba nada: en el ensayo esa fila casi siempre ES un listo
   * —los deja simulate-flow, con MOCK_AI— y con el fantasma vivo también daba
   * una marcada y cifra 1. Se marca en una pestaña y se salta a otra: un
   * siniestro tiene un solo estado, no puede estar en las dos.
   *
   * La otra pestaña puede estar vacía, y sin filas no hay barra que mirar. Por
   * eso se vuelve: lo podado no reaparece marcado junto con la fila.
   */
  test("cambiar de pestaña deja el contador diciendo la verdad", async ({ page }) => {
    await page.goto("/bandeja");
    const pestana = (clave: "listo" | "esperando") => ({
      tab: page.getByRole("tab", { name: enCualquierIdioma(`tabs.${clave}`) }),
      url: new RegExp(`status=${clave}`),
    });
    // Las cifras vienen del servidor; la tabla no sirve para decidir, en la
    // ventana entre URL y data muestra la página vieja filtrada acá.
    const vacia = async (p: ReturnType<typeof pestana>) =>
      (await p.tab.locator(".cifra").innerText()) === "0";
    const listos = pestana("listo");
    const esperando = pestana("esperando");
    const [origen, destino] = (await vacia(listos)) ? [esperando, listos] : [listos, esperando];
    test.skip(await vacia(origen), "sin casos listos ni esperando no hay fila que marcar");

    await origen.tab.click();
    await expect(page).toHaveURL(origen.url, { timeout: 15_000 });
    await page.getByRole("button", { name: enCualquierIdioma("bandeja.seleccionar") }).click();
    await page.getByRole("checkbox").first().click();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(1);

    await destino.tab.click();
    await expect(page).toHaveURL(destino.url, { timeout: 15_000 });
    // Con filas la barra dice 0 y no ofrece borrar; sin filas no hay barra.
    await expect(
      page.getByRole("button", { name: enCualquierIdioma("bandeja.deleteSelected") })
    ).toHaveCount(0);

    await origen.tab.click();
    await expect(page).toHaveURL(origen.url, { timeout: 15_000 });
    await expect(filas(page).first()).toBeVisible();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(
      page.getByRole("toolbar", { name: enCualquierIdioma("bandeja.seleccionar") }).locator(".cifra")
    ).toHaveText("0");
  });
});
