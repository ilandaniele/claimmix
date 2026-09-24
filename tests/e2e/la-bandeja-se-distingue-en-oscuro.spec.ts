/**
 * La bandeja se lee en oscuro, no sólo pasa el test que lee el CSS.
 *
 * `contraste-oscuro.test.ts` saca los colores de `globals.css` con una regex y
 * hace la cuenta de WCAG con ellos: rápido, sin navegador, pero sólo prueba
 * que EL TEXTO del archivo diga lo que dice. No corre la cascada — un
 * selector con más especificidad pisando el mismo borde más abajo, una
 * variable de Tailwind que no resuelve donde se pensó, una clase que llegó
 * mal escrita a la tarjeta real — queda invisible para esa lectura, y visible
 * recién cuando alguien mira la pantalla. Nadie la había mirado todavía.
 *
 * Este test sí abre la pantalla, la pone en oscuro como lo dejaría el botón de
 * tema —el mismo `localStorage` que lee `ThemeContext`, no una clase puesta a
 * mano en el DOM que ningún usuario real produce— y mide con
 * `getComputedStyle` lo que el navegador terminó pintando: el borde de la
 * tarjeta contra su propio fondo, y el de los tres controles del encabezado
 * contra esa misma tarjeta. Las capturas no reemplazan la medición —un color
 * mal puesto no salta a la vista en una captura chica— pero quedan adjuntas
 * al reporte para que una persona las abra si esto se cae.
 */

import { test, expect } from "@playwright/test";
import { SESION_ANALISTA } from "./sesiones";
import { enCualquierIdioma } from "./texto";
import { CLAVE_TEMA } from "@/lib/theme/script-inicial";

const HAY_ANALISTA = !!(
  process.env.PLAYWRIGHT_TEST_EMAIL && process.env.PLAYWRIGHT_TEST_PASSWORD
);

interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

test.describe("la bandeja en modo oscuro", () => {
  test.skip(!HAY_ANALISTA, "Falta PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD");
  test.use({ storageState: SESION_ANALISTA, viewport: { width: 1280, height: 800 } });

  test("la tarjeta y los controles del encabezado se distinguen del fondo", async ({
    page,
  }, testInfo) => {
    /*
     * Primero en claro, a propósito y no lo que trajera la sesión guardada:
     * así la captura de comparación arranca siempre de la misma pantalla, sin
     * depender de qué tema haya quedado puesto la última vez que se grabó
     * `SESION_ANALISTA`.
     */
    await page.addInitScript((clave) => window.localStorage.setItem(clave, "light"), CLAVE_TEMA);
    await page.goto("/bandeja");
    await expect(page.locator('[data-scroll="lista"]').filter({ visible: true })).toBeVisible({
      timeout: 15_000,
    });
    await testInfo.attach("bandeja-claro", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    /*
     * Ahora oscuro, de la misma forma en que lo deja el botón de tema: escrito
     * en el `localStorage` antes de que la página cargue, para que el script
     * del `<head>` —`SCRIPT_TEMA_INICIAL`— sea quien pone la clase, igual que
     * en un navegador real.
     */
    await page.addInitScript((clave) => window.localStorage.setItem(clave, "dark"), CLAVE_TEMA);
    await page.goto("/bandeja");

    /*
     * Mientras el servidor manda la página por partes, la lista puede estar dos
     * veces en el DOM —la que ya llegó, todavía escondida, y la que se ve— y
     * con staging lento eso dura más que los cinco segundos por omisión.
     */
    const lista = page.locator('[data-scroll="lista"]').filter({ visible: true });
    await expect(lista).toBeVisible({ timeout: 15_000 });

    const quedoEnOscuro = await page.evaluate(() =>
      document.documentElement.classList.contains("dark")
    );
    expect(quedoEnOscuro, "el localStorage no dejó puesta la clase que usa globals.css").toBe(
      true
    );

    // La tarjeta es el `<section>` de `Card` que envuelve toda la bandeja: el
    // único ancestro `section` de la lista.
    const tarjeta = lista.locator("xpath=ancestor::section[1]");
    const filtros = page.locator('[data-testid="filtros-boton"]');
    const exportar = tarjeta.getByRole("link", { name: enCualquierIdioma("bandeja.export") });
    const seleccionar = tarjeta.getByRole("button", {
      name: enCualquierIdioma("bandeja.seleccionar"),
    });

    await expect(tarjeta).toBeVisible();
    await expect(filtros).toBeVisible();
    await expect(exportar).toBeVisible();
    await expect(seleccionar).toBeVisible();

    const [tarjetaMango, filtrosMango, exportarMango, seleccionarMango] = await Promise.all([
      tarjeta.elementHandle(),
      filtros.elementHandle(),
      exportar.elementHandle(),
      seleccionar.elementHandle(),
    ]);
    if (!tarjetaMango || !filtrosMango || !exportarMango || !seleccionarMango) {
      throw new Error("no encontré alguno de los elementos a medir");
    }

    const medidas = await page.evaluate(
      ({ tarjeta, filtros, exportar, seleccionar }) => {
        function parseColor(cadena: string): Color | null {
          const m = /^rgba?\(([^)]+)\)$/.exec(cadena.trim());
          if (!m) return null;
          const [r, g, b, a] = m[1].split(",").map((n) => parseFloat(n));
          return { r, g, b, a: a === undefined ? 1 : a };
        }

        /*
         * Un borde translúcido pinta la mezcla con lo que hay debajo: sin
         * esto, un `rgba()` a medio camino podría dar un contraste que la
         * pantalla nunca muestra.
         */
        function sobreFondo(color: Color | null, fondo: Color | null): Color | null {
          if (!color || !fondo || color.a >= 1) return color;
          return {
            r: color.r * color.a + fondo.r * (1 - color.a),
            g: color.g * color.a + fondo.g * (1 - color.a),
            b: color.b * color.a + fondo.b * (1 - color.a),
            a: 1,
          };
        }

        function canal(v: number): number {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        }

        function luminancia(color: Color): number {
          return 0.2126 * canal(color.r) + 0.7152 * canal(color.g) + 0.0722 * canal(color.b);
        }

        function contraste(a: Color | null, b: Color | null): number | null {
          if (!a || !b) return null;
          const la = luminancia(a);
          const lb = luminancia(b);
          return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        }

        const fondoTarjeta = parseColor(getComputedStyle(tarjeta).backgroundColor);
        const bordeTarjeta = sobreFondo(
          parseColor(getComputedStyle(tarjeta).borderTopColor),
          fondoTarjeta
        );
        const bordeFiltros = sobreFondo(
          parseColor(getComputedStyle(filtros).borderTopColor),
          fondoTarjeta
        );
        const bordeExportar = sobreFondo(
          parseColor(getComputedStyle(exportar).borderTopColor),
          fondoTarjeta
        );
        const bordeSeleccionar = sobreFondo(
          parseColor(getComputedStyle(seleccionar).borderTopColor),
          fondoTarjeta
        );

        return {
          tarjetaVsFondo: contraste(bordeTarjeta, fondoTarjeta),
          filtrosVsTarjeta: contraste(bordeFiltros, fondoTarjeta),
          exportarVsTarjeta: contraste(bordeExportar, fondoTarjeta),
          seleccionarVsTarjeta: contraste(bordeSeleccionar, fondoTarjeta),
          sombra: getComputedStyle(tarjeta).boxShadow,
        };
      },
      {
        tarjeta: tarjetaMango,
        filtros: filtrosMango,
        exportar: exportarMango,
        seleccionar: seleccionarMango,
      }
    );

    // eslint-disable-next-line no-console -- a propósito: que quede en el log de CI.
    console.log(
      `contraste en oscuro — tarjeta ${medidas.tarjetaVsFondo?.toFixed(2)}:1, ` +
        `filtros ${medidas.filtrosVsTarjeta?.toFixed(2)}:1, ` +
        `exportar ${medidas.exportarVsTarjeta?.toFixed(2)}:1, ` +
        `seleccionar ${medidas.seleccionarVsTarjeta?.toFixed(2)}:1`
    );

    /*
     * Techos un escalón por debajo de lo que da hoy `globals.css` (1,57 el
     * borde de tarjeta, 3,41 el de los controles): guardan la regresión sin
     * quedar pegados al último decimal.
     */
    expect(medidas.tarjetaVsFondo, "borde de la tarjeta").not.toBeNull();
    expect(medidas.tarjetaVsFondo!).toBeGreaterThanOrEqual(1.4);

    expect(medidas.filtrosVsTarjeta, "borde de «Filtros»").not.toBeNull();
    expect(medidas.filtrosVsTarjeta!).toBeGreaterThanOrEqual(3);

    expect(medidas.exportarVsTarjeta, "borde de «Exportar CSV»").not.toBeNull();
    expect(medidas.exportarVsTarjeta!).toBeGreaterThanOrEqual(3);

    expect(medidas.seleccionarVsTarjeta, "borde de «Seleccionar»").not.toBeNull();
    expect(medidas.seleccionarVsTarjeta!).toBeGreaterThanOrEqual(3);

    expect(medidas.sombra, "la tarjeta perdió su sombra en oscuro").not.toBe("none");

    await testInfo.attach("bandeja-oscuro", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
});
