import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx", "tests/integration/**/*.test.ts"],
    exclude: ["tests/e2e/**", "tests/stress/**"],
    // Process-level isolation: each test file runs in its own worker process.
    // This prevents module-cache contamination when multiple test files
    // import the same Next.js route handler via `await import(...)`.
    // Without this, mocked db instances leak across files.
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      // `src/core/**` y `src/data/**` no estaban, y son el código donde vive
      // ahora la decisión (el núcleo) y el aislamiento entre aseguradoras (la
      // capa). Medir cobertura sin ellos daba un número que subía mientras la
      // parte que más importa quedaba sin mirar.
      include: [
        "src/lib/**",
        "src/server/**",
        "src/core/**",
        "src/data/**",
        "src/workflows/**",
      ],
      exclude: [
        // Type definition files
        "**/*.d.ts",
        // Las tablas de drizzle son declaraciones, no lógica: `pgTable("cases",
        // { … })` y callbacks de referencia como `() => tenants.id`. v8 cuenta
        // cada columna como una sentencia y cada referencia como una función
        // sin cubrir, así que una tabla que ningún test toca hunde el número
        // sin que exista nada que probar. Incluirlas medía cuántas tablas usan
        // los tests, no cuánto código está probado.
        "src/lib/db/schema/**",
        // Piezas de prueba del suite de flujos durables: corren con
        // `pnpm flujos`, que necesita el compilador de directivas y por eso va
        // en su propia configuración. Acá figuran como código sin cubrir.
        "src/workflows/_prueba*",
        // Drizzle db index — requires DATABASE_URL at runtime; tested via integration tests.
        "src/lib/db/index.ts",
        // Observability — require Sentry DSN and pino runtime at module init.
        // Covered by manual/integration testing.
        "src/lib/observability/**",
        // Upstash rate-limit adapter — requires UPSTASH_* env vars at runtime.
        "src/lib/rate-limit/upstash.ts",
        // Acá se excluían cinco archivos con la explicación «sólo se cubre por
        // integración». Medido, no era cierto en ninguno de los cinco:
        //
        //     budget.ts        82,6 % de líneas
        //     dispatch.ts      79,8 %
        //     extract.ts       68,5 %
        //     dedupe.ts        31,0 %
        //     thread-lookup.ts  6,8 %
        //
        // O sea que los tests que ya existían no contaban, y —peor— si mañana
        // alguien borra el 82 % de `budget.ts`, el número no se mueve. Excluir
        // un archivo con lógica porque «se cubre en otro lado» es la misma
        // clase de verde que este repo viene sacando de todos lados: convence
        // sin mirar nada.
        //
        // Los que quedan afuera abajo no tienen lógica que probar. (Acá también
        // se excluía "src/server/ai/openai-extractor.ts", un archivo que ya no
        // existe: el extractor de OpenAI se borró cuando el producto quedó sólo
        // con Gemini.)
        //
        // Cargador de i18n del servidor: tres líneas de `import()` detrás del
        // guard de `server-only`. La lógica vive en locale-shared.ts, que sí se
        // mide.
        "src/lib/i18n/locale.ts",
        // CoreSync interface + mock — no real external API implemented.
        // Exercised by integration tests.
        "src/server/core-sync/client.ts",
        "src/server/core-sync/mock.ts",
        // Gmail poller — long-running loop that calls the live Gmail API.
        "src/server/email/gmail/gmail-poller.ts",
        // R2 attachments bucket — requires R2_* env vars at runtime.
        "src/server/storage/claim-attachments-bucket.ts",
      ],
      /**
       * El piso, no la meta.
       *
       * Estaba en 80 y la cobertura real era 70: el gate fallaba siempre, así
       * que nadie lo corría, y una barrera que no se cruza nunca no frena
       * nada. Un piso que se cumple es lo que convierte al número en trinquete
       * — puede subir, no puede bajar.
       *
       * Se sube cuando se sube de verdad. `pnpm cobertura` dice dónde está.
       *
       *   26/08/2026   71.99 / 62.08 / 74.24 / 73.08
       *   10/09/2026   78.25 / 69.20 / 80.17 / 78.86   ← con los cinco archivos
       *                                                  que estaban excluidos
       *   10/09/2026   78.50 / 69.67 / 80.71 / 79.12   ← después de los tests de
       *                                                  `env-local` y del ensayo
       *
       * Con el margen de un punto que se viene usando, sólo `lines` se mueve.
       * Las otras tres ya están a menos de un punto y subirlas sería poner el
       * piso donde un refactor cualquiera lo toca.
       *
       * Habían quedado siete puntos atrás: el trinquete dejaba de trincar. Un
       * piso siete puntos abajo permite borrar la mitad de los tests de un
       * archivo sin que nada se ponga en rojo.
       */
      thresholds: {
        lines: 78,
        functions: 79,
        branches: 68,
        statements: 77,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      // Mock 'server-only' in test environment — it's a Next.js-only guard
      // that prevents server modules from being imported client-side.
      // In tests, we can safely bypass it.
      "server-only": resolve(__dirname, "./tests/mocks/server-only.ts"),
    },
  },
});
