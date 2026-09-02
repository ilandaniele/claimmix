/**
 * La pantalla de configuración: quién entra y qué ve.
 *
 * Antes se llamaba `gmail-status.spec.ts` y probaba dos cosas: la pantalla y la
 * ruta `/api/admin/gmail-status`. Esa ruta se borró —su única pantalla,
 * `GmailStatusSection`, había quedado huérfana al reorganizarse configuración, y
 * lo que mostraba se ve hoy por cuenta en `GmailAccountsPanel` y a nivel sistema
 * en `/api/health`— así que quedan los tests de la pantalla, que es lo que sigue
 * existiendo.
 *
 * Los dos escenarios con sesión reusan la sesión que deja `auth.setup.ts`. Se
 * saltean solos si no hay credenciales configuradas.
 */

import { test, expect } from "@playwright/test";
import { SESION_ADMIN, SESION_ANALISTA } from "./sesiones";
import { enCualquierIdioma } from "./texto";

const ADMIN_EMAIL = process.env.PLAYWRIGHT_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PLAYWRIGHT_ADMIN_PASSWORD;
const ANALYST_EMAIL = process.env.PLAYWRIGHT_ANALYST_EMAIL ?? process.env.PLAYWRIGHT_TEST_EMAIL;
const ANALYST_PASSWORD =
  process.env.PLAYWRIGHT_ANALYST_PASSWORD ?? process.env.PLAYWRIGHT_TEST_PASSWORD;

const HAY_ADMIN = !!(ADMIN_EMAIL && ADMIN_PASSWORD);
const HAY_ANALISTA = !!(ANALYST_EMAIL && ANALYST_PASSWORD);

test.describe("configuración sin sesión", () => {
  /*
   * Sin sesión, al login. Y se afirma eso, no una disyunción.
   *
   * Decía `expect(isAtLogin || isAtConfig).toBe(true)`, que es verdadero
   * caiga donde caiga: si el guardia dejara de redirigir, el test seguía en
   * verde. Un chequeo así se lee como cobertura de una ruta privada y no
   * cubre nada.
   *
   * `proxy.ts` redirige a `/login` con el destino en `?redirect=`, así que se
   * comprueba el destino Y que la pantalla privada no se haya pintado.
   */
  test("una visita anónima a /configuracion termina en el login", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto("/configuracion");

    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: enCualquierIdioma("gmail.accounts.title") })
    ).not.toBeVisible();
  });
});

test.describe("configuración como admin", () => {
  test.skip(!HAY_ADMIN, "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD");

  /*
   * La sesión sale del archivo que dejó `auth.setup.ts`.
   *
   * El login limita a cinco intentos cada diez segundos por IP y correo. Con
   * cada test entrando de cero, los tests se comían su propio cupo y fallaban
   * con «Demasiados intentos» — que en el reporte se lee como un login roto.
   */
  test.use({ storageState: SESION_ADMIN });

  test("un admin abre configuración y ve la sección de cuentas Gmail", async ({ page }) => {
    await page.goto("/configuracion");
    await expect(page).not.toHaveURL(/\/login/);

    await expect(
      page.getByRole("heading", { name: enCualquierIdioma("gmail.accounts.title") })
    ).toBeVisible();
  });
});

test.describe("configuración como analista", () => {
  test.skip(!HAY_ANALISTA, "Falta PLAYWRIGHT_ANALYST_EMAIL / PLAYWRIGHT_ANALYST_PASSWORD");

  test.use({ storageState: SESION_ANALISTA });

  /*
   * Un analista ve la MISMA sección, y eso es deliberado.
   *
   * Antes esto afirmaba que NO la veía, y pasaba por la razón equivocada:
   * buscaba un encabezado —«Bandeja de entrada Gmail»— que ya no existe para
   * nadie. Un verde así se lee como separación de roles comprobada y no
   * comprobaba nada.
   *
   * Lo que separa a un analista de un admin acá es la API:
   * `GET /api/admin/gmail-accounts` le devuelve sólo las cuentas que conectó
   * él, y el alta y la baja piden rol de admin.
   */
  test("un analista también ve la sección, que es lo que corresponde hoy", async ({ page }) => {
    await page.goto("/configuracion");
    await expect(page).not.toHaveURL(/\/login/);

    await expect(
      page.getByRole("heading", { name: enCualquierIdioma("gmail.accounts.title") })
    ).toBeVisible();
  });
});

/**
 * La pantalla de clientes muestra DNI, correo y teléfono.
 *
 * No chequeaba rol: un analista los veía por ahí y recibía 403 pidiendo esos
 * mismos campos a `/api/customers`. El enlace además está en la barra lateral
 * sin condición de rol, y el propio repo dice en `(app)/layout.tsx` que esconder
 * un enlace no es una guarda — acá no estaba ni escondido.
 *
 * Se comprueba con un navegador porque la guarda es un `redirect` del servidor:
 * un test de unidad sobre el módulo no vería la redirección.
 */
test.describe("el padrón de clientes", () => {
  test.skip(!HAY_ANALISTA, "Falta PLAYWRIGHT_ANALYST_EMAIL / PLAYWRIGHT_ANALYST_PASSWORD");
  test.use({ storageState: SESION_ANALISTA });

  test("un analista no entra a /clientes", async ({ page }) => {
    await page.goto("/clientes");

    await expect(page).toHaveURL(/\/bandeja/);
    /*
     * Por clave y no por texto: es una afirmacion NEGATIVA, asi que un
     * encabezado que no matchea por estar en el otro idioma la deja pasar
     * sola. `clientes.col.dni` es «DNI» en castellano y «ID number» en
     * ingles: con la interfaz en ingles, `/dni/i` daba verde aunque la tabla
     * se hubiera pintado entera.
     */
    await expect(page.getByRole("columnheader", { name: enCualquierIdioma("clientes.col.dni") })).not.toBeVisible();
  });

  test("tampoco al detalle de un cliente", async ({ page }) => {
    // Un id cualquiera: la guarda tiene que correr antes de buscarlo.
    await page.goto("/clientes/00000000-0000-4000-8000-000000000000");
    await expect(page).toHaveURL(/\/bandeja/);
  });
});

test.describe("el padrón de clientes, como admin", () => {
  test.skip(!HAY_ADMIN, "Falta PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD");
  test.use({ storageState: SESION_ADMIN });

  test("un admin sí entra", async ({ page }) => {
    // La otra mitad: una guarda que bloquea a todo el mundo también pasaría el
    // test de arriba.
    await page.goto("/clientes");
    await expect(page).not.toHaveURL(/\/bandeja/);
    await expect(page).toHaveURL(/\/clientes/);
  });
});
