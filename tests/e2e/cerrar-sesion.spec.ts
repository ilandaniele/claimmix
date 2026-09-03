/**
 * Cerrar sesión desde la barra: tiene que TERMINAR en el login.
 *
 * El síntoma que motivó esto fue «apreto salir, tarda, queda colgado, parece
 * que no apreté». Un test que sólo mira que el botón exista no lo agarra; éste
 * aprieta y espera el destino. Y después vuelve a pedir una pantalla privada
 * para comprobar que la sesión se cerró de verdad, no que sólo se navegó.
 *
 * Reusa la sesión que deja `auth.setup.ts`; se saltea sin credenciales.
 */

import { test, expect } from "@playwright/test";
import { SESION_ADMIN } from "./sesiones";

const HAY_ADMIN = !!(process.env.PLAYWRIGHT_ADMIN_EMAIL && process.env.PLAYWRIGHT_ADMIN_PASSWORD);

test.describe("cerrar sesión", () => {
  test.skip(!HAY_ADMIN, "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD");
  test.use({ storageState: SESION_ADMIN });

  test("apretar salir lleva al login, y la sesión queda cerrada", async ({ page }) => {
    await page.goto("/bandeja");
    await expect(page).not.toHaveURL(/\/login/);

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
