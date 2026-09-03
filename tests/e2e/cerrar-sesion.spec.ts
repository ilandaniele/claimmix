/**
 * Cerrar sesión desde la barra: tiene que TERMINAR en el login.
 *
 * El síntoma que motivó esto fue «apreto salir, tarda, queda colgado, parece
 * que no apreté». Un test que sólo mira que el botón exista no lo agarra; éste
 * aprieta y espera el destino. Y después vuelve a pedir una pantalla privada
 * para comprobar que la sesión se cerró de verdad, no que sólo se navegó.
 *
 * ── Entra con SU sesión, no con la compartida ───────────────────────────────
 *
 * La primera versión reusaba `SESION_ADMIN`, la que deja `auth.setup.ts` para
 * toda la suite. Cerrar sesión borra la fila en la base; el `storageState`
 * sigue teniendo la cookie pero del otro lado ya no hay nada, así que cada spec
 * que corría después quedaba deslogueado. Este test pasaba y rompía al
 * siguiente — un fixture compartido destruido por quien lo usa, que es la misma
 * clase de bug que ya nos había costado una tarde con el idioma de staging.
 *
 * Por eso entra por la pantalla con las credenciales, como hace el setup, y
 * cierra únicamente la sesión que él mismo abrió. Cuesta un login más por run;
 * el tope es cinco cada diez segundos por IP y correo, y el setup usa dos.
 */

import { test, expect } from "@playwright/test";

const CORREO = process.env.PLAYWRIGHT_ADMIN_EMAIL;
const CLAVE = process.env.PLAYWRIGHT_ADMIN_PASSWORD;

test.describe("cerrar sesión", () => {
  test.skip(!CORREO || !CLAVE, "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD");

  test("apretar salir lleva al login, y la sesión queda cerrada", async ({ page }) => {
    await page.goto("/login");
    await page.fill('[name="email"]', CORREO!);
    await page.fill('[name="password"]', CLAVE!);
    await Promise.all([page.waitForURL(/\/bandeja/), page.click('[type="submit"]')]);
    await expect(page).toHaveURL(/\/bandeja/);

    const salir = page.getByTestId("signout-button");
    await expect(salir).toBeEnabled();
    await salir.click();

    // Generoso a propósito: el viaje a Neon en el plan gratuito puede tardar.
    // Lo que se afirma es que LLEGA, que es exactamente lo que no pasaba.
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

    // Y que no fue sólo una navegación: una ruta privada tiene que rebotar.
    await page.goto("/bandeja");
    await expect(page).toHaveURL(/\/login/);
  });
});
