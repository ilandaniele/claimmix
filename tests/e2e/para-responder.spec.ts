/**
 * «Para responder»: el enlace de la barra y el botón «Marcar como respondido».
 *
 * Sin sembrar nada: un caso marcado depende de que el agente haya terminado y
 * alguien vuelva a escribir, y eso lo ensaya `escribe-despues-del-cierre`. Acá
 * se prueba que la sección existe y que la ruta responde lo prometido con un
 * caso que no existe, que no modifica ninguna fila.
 */

import { test, expect } from "@playwright/test";
import { SESION_ANALISTA } from "./sesiones";
import { enCualquierIdioma } from "./texto";

const HAY_ANALISTA = !!(
  process.env.PLAYWRIGHT_TEST_EMAIL && process.env.PLAYWRIGHT_TEST_PASSWORD
);
const CASO_INEXISTENTE = "00000000-0000-0000-0000-000000000001";

test("POST /api/cases/:id/respondido sin sesión da 401", async ({ page }) => {
  const res = await page.request.post(`/api/cases/${CASO_INEXISTENTE}/respondido`);
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe("MISSING_SESSION");
});

test.describe("«Para responder» con sesión", () => {
  test.skip(!HAY_ANALISTA, "Falta PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD");
  test.use({ storageState: SESION_ANALISTA });

  test("el enlace de la barra abre la bandeja filtrada", async ({ page }) => {
    await page.goto("/bandeja");
    await page
      .getByRole("navigation", { name: enCualquierIdioma("nav.principal") })
      .getByRole("link", { name: enCualquierIdioma("bandeja.paraResponder", { exacto: true }) })
      .click();

    // Misma ruta con otra query: la URL cambia recién cuando contesta el servidor.
    await expect(page).toHaveURL(/para_responder=true/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { level: 1, name: enCualquierIdioma("bandeja.paraResponder") })
    ).toBeVisible();
  });

  test("marcar un caso que no existe contesta que no había nada que sacar", async ({ page }) => {
    const res = await page.request.post(`/api/cases/${CASO_INEXISTENTE}/respondido`, {
      data: { visto: new Date().toISOString() },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ actualizado: false });
  });

  // Sin `visto` no se sabe qué vio quien contesta: no se saca la marca a ciegas.
  test("marcar sin `visto` da 400", async ({ page }) => {
    const res = await page.request.post(`/api/cases/${CASO_INEXISTENTE}/respondido`);
    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
  });
});
