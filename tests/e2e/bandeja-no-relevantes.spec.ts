/**
 * «No relevantes» de la barra lateral lleva a la bandeja filtrada por
 * `is_claim=false`, y lo que la bandeja cuenta ahí es lo que cuenta la API.
 *
 * No se mira la situación de cada fila: un caso que no es denuncia puede no
 * estar en `no_relevante` (se reabre y vuelve a `recibido`). Lo que sí tiene
 * que coincidir es el total.
 */

import { test, expect, type Page } from "@playwright/test";
import { SESION_ADMIN } from "./sesiones";
import { enCualquierIdioma } from "./texto";
import { totalDelPie } from "./bandeja";

const HAY_ADMIN = !!(
  process.env.PLAYWRIGHT_ADMIN_EMAIL && process.env.PLAYWRIGHT_ADMIN_PASSWORD
);

async function totalDeLaApi(page: Page): Promise<number> {
  const res = await page.request.get("/api/cases?is_claim=false");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { meta: { total: number } }).meta.total;
}

test.describe("no relevantes desde la barra", () => {
  test.skip(!HAY_ADMIN, "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD");
  test.use({ storageState: SESION_ADMIN });

  test("el enlace filtra por is_claim=false y el pie cuenta lo mismo que la API", async ({ page }) => {
    await page.goto("/bandeja");

    // Sin casos no hay tabla ni pie: la bandeja muestra su estado vacío.
    test.skip((await totalDeLaApi(page)) === 0, "el tenant no tiene casos que no sean denuncias");

    await page
      .getByRole("navigation", { name: enCualquierIdioma("nav.principal") })
      .getByRole("link", { name: enCualquierIdioma("nav.noRelevantes", { exacto: true }) })
      .click();

    // Misma ruta con otra query: la URL cambia recién cuando contesta el
    // servidor, y en un enlace lento son segundos.
    await expect(page).toHaveURL(/is_claim=false/, { timeout: 15_000 });
    // Literal y no del diccionario: armado con `enCualquierIdioma`, volver a
    // «Estado» también pasaba.
    await expect(
      page.getByRole("columnheader", { name: /^(Situación|Status)$/i })
    ).toBeVisible();
    // Contra la API en cada vuelta y no contra un total fijo: si en staging
    // entra un no relevante mientras tanto, suben los dos. El pie lo ve en el
    // próximo sondeo, que puede estar hasta treinta segundos más allá.
    await expect
      .poll(async () => (await totalDelPie(page)) - (await totalDeLaApi(page)), { timeout: 35_000 })
      .toBe(0);
  });
});
