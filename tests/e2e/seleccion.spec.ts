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

const HAY_ADMIN = !!(
  process.env.PLAYWRIGHT_ADMIN_EMAIL && process.env.PLAYWRIGHT_ADMIN_PASSWORD
);

test.describe("selección sin recuadros", () => {
  test.skip(!HAY_ADMIN, "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD");
  test.use({ storageState: SESION_ADMIN });

  test("no hay casillas hasta entrar al modo; seleccionar todos marca la página; Listo limpia", async ({ page }) => {
    await page.goto("/bandeja");
    const filas = page.locator('[data-scroll="lista"] tbody tr');
    await expect(filas.first()).toBeVisible();
    const enPagina = await filas.count();

    // Fuera del modo: ni un control de selección en la tabla.
    await expect(page.getByRole("checkbox")).toHaveCount(0);

    await page.getByRole("button", { name: enCualquierIdioma("bandeja.seleccionar") }).click();

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
});
