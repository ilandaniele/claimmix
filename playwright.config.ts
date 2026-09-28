import { defineConfig, devices } from "@playwright/test";

import { exigirQueNoSeaProduccion } from "./tests/e2e/base-de-ensayo";

exigirQueNoSeaProduccion();

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html"], ["github"]] : [["html"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    /*
     * Entrar una vez, y que el resto reuse la sesión.
     *
     * Este proyecto corre antes que los tests y deja las cookies en un archivo
     * por rol. Sin él, cada test que necesitaba sesión se logueaba de cero: nueve
     * inicios seguidos contra la misma cuenta, y el login limita a cinco cada
     * diez segundos. Los tests se comían su propio cupo.
     *
     * Ver tests/e2e/auth.setup.ts para por qué no se toca el límite.
     */
    { name: "setup", testMatch: /auth.setup.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      /*
       * Sin `storageState` acá a propósito: el proyecto arranca SIN sesión.
       *
       * Media suite comprueba justamente lo contrario —que una ruta privada
       * mande al login, que la demostración abra sin cuenta— y ponerle sesión a
       * todo el proyecto las haría pasar por la razón equivocada. La sesión se
       * pide donde hace falta, con `test.use({ storageState })`.
       */
    },
  ],
  webServer: {
    /*
     * En CI, el build de producción, que el job arma en el paso anterior.
     *
     * `next dev` compila cada ruta la primera vez que se pide y Turbopack no
     * devuelve esa memoria. En el runner de un repo privado —7 GB y 3 GB de
     * swap— la suite lo llenaba en tres minutos y GitHub apagaba la máquina a
     * mitad de los tests, sin un error de Node que lo explicara. `next start`
     * arranca con todo compilado y con el mismo `NODE_ENV` que producción.
     */
    command: process.env.CI ? "pnpm start" : "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    timeout: 120_000,

    /*
     * La salida del servidor, a la vista.
     *
     * Playwright ignora su stdout por omisión, así que cuando el servidor no
     * levanta el error es «Timed out waiting 120000ms» y nada más: no se
     * distingue una compilación lenta de un proceso que murió al arrancar.
     * Pasó, y hubo que adivinar. Con esto, el log dice cuál de las dos fue.
     */
    stdout: "pipe",
    stderr: "pipe",
    env: {
      MOCK_AI: "true",

      /*
       * La base, pasada a mano y no heredada del ambiente.
       *
       * `pnpm dev` levanta Next, y Next lee `.env.local` — donde vive la cadena
       * de PRODUCCIÓN. Por eso un servidor que ya estuviera escuchando nunca se
       * reusa (`reuseExistingServer: false`, arriba): habría leído esa base, y
       * levantar el propio con la que sigue es la única forma de estar seguros
       * de contra qué corre.
       *
       * `exigirQueNoSeaProduccion()`, más arriba en este archivo, es el cinturón
       * además: para cuando alguien exportó producción a mano en la terminal
       * antes de correr esto.
       */
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      DATABASE_URL_APP: process.env.DATABASE_URL_APP ?? "",
    },
  },
});
