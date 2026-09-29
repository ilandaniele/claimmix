/**
 * La API de lectura del sistema central (B5), de punta a punta: un admin crea
 * la clave en /configuracion y un cliente SIN sesión lee con ella.
 *
 * Corre contra la base de ENSAYO (`exigirQueNoSeaProduccion`). Rotar la clave
 * reemplaza la que hubiera en el inquilino de los e2e, y al final se revoca.
 * No toca `enabled`: el webhook no se prende nunca desde acá, y cada llamada
 * más a la ruta admin gasta del cupo de 5 por minuto que comparten los
 * reintentos de CI.
 *
 * Sin la migración 0036 en la base de ensayo, se saltea diciéndolo.
 */

import { test, expect } from "@playwright/test";

import { exigirQueNoSeaProduccion } from "./base-de-ensayo";
import { SESION_ADMIN } from "./sesiones";
import { enCualquierIdioma } from "./texto";

exigirQueNoSeaProduccion();

const HAY_ADMIN = !!(process.env.PLAYWRIGHT_ADMIN_EMAIL && process.env.PLAYWRIGHT_ADMIN_PASSWORD);

test.describe("/api/v1 con la clave de la aseguradora", () => {
  test.skip(!HAY_ADMIN, "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD");
  test.use({ storageState: SESION_ADMIN });

  test("la clave recién rotada lee; alterada, no", async ({ page, playwright, baseURL }) => {
    await page.goto("/configuracion");
    await expect(page.getByRole("heading", { name: enCualquierIdioma("configuracion.core.titulo") })).toBeVisible();
    test.skip(
      await page.getByText(enCualquierIdioma("configuracion.core.migracionPendiente")).isVisible(),
      "La base de ensayo no tiene la migración 0036"
    );

    // Si ya había una clave, el botón es «Rotar» y pide confirmación.
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", {
        name: new RegExp(
          `${enCualquierIdioma("configuracion.core.crearClave").source}|${enCualquierIdioma("configuracion.core.rotarClave").source}`,
          "i"
        ),
      })
      .click();
    const revelada = page.getByRole("alert", { name: enCualquierIdioma("configuracion.core.claveNueva") }).locator("code");
    await expect(revelada).toHaveText(/^cmk_/);
    const clave = (await revelada.textContent()) ?? "";
    expect(clave).toMatch(/^cmk_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);

    // Un cliente aparte, sin las cookies de la sesión: entra sólo por la clave.
    const core = await playwright.request.newContext({ baseURL });
    try {
      const ok = await core.get("/api/v1/cases?per_page=5", {
        headers: { Authorization: `Bearer ${clave}` },
      });
      expect(ok.status()).toBe(200);
      expect(ok.headers()["cache-control"]).toBe("no-store");
      const pagina = await ok.json();
      expect(Array.isArray(pagina.data)).toBe(true);
      expect(pagina.meta.per_page).toBe(5);

      const ultimo = clave.at(-1) === "A" ? "B" : "A";
      const alterada = await core.get("/api/v1/cases", {
        headers: { Authorization: `Bearer ${clave.slice(0, -1)}${ultimo}` },
      });
      expect(alterada.status()).toBe(401);
      expect(alterada.headers()["www-authenticate"]).toBe("Bearer");
    } finally {
      await core.dispose();
      const revocada = await page.request.post("/api/admin/core-sync", { data: { accion: "revocar-clave" } });
      expect(revocada.status()).toBe(200);
    }
  });
});
