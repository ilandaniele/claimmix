import { defineConfig, devices } from "@playwright/test";

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
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      MOCK_AI: "true",

      /*
       * La base, pasada a mano y no heredada del ambiente.
       *
       * `pnpm dev` levanta Next, y Next lee `.env.local` — donde vive la cadena
       * de PRODUCCIÓN. Los e2e escriben: crean casos, sesiones, filas del límite
       * de tráfico. Corriendo así, todo eso caía en la base de los clientes, y no
       * se notaba porque los tests que no necesitan datos pasan igual contra
       * cualquier base.
       *
       * Se notó recién al sembrar cuentas de prueba en el ensayo: el login
       * respondía «Credenciales inválidas» porque el servidor miraba producción,
       * donde esas cuentas no existen. El síntoma decía «login roto» y el problema
       * era a qué base le hablaba.
       */
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      DATABASE_URL_APP: process.env.DATABASE_URL_APP ?? "",
    },
  },
});
