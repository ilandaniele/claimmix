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
        // Email infrastructure — require provider credentials at runtime.
        // Covered by integration tests with mocked clients, not unit tests.
        "src/server/email/dispatch.ts",
        "src/server/email/thread-lookup.ts",
        // Idempotency check — db query, no testable branch logic beyond DB call.
        // Covered via integration tests.
        "src/server/email/dedupe.ts",
        // AI budget guard — requires live DB; covered by integration tests only.
        "src/server/ai/budget.ts",
        // OpenAI SDK wrapper — requires OPENAI_API_KEY at runtime.
        "src/server/ai/openai-extractor.ts",
        // Extraction worker orchestrator — DB-orchestration pipeline.
        // All constituent modules are individually unit-tested.
        // Covered end-to-end via integration tests.
        "src/server/worker/extract.ts",
        // Server-only i18n loader — uses `server-only` guard; intentionally excluded from
        // client bundle. The shared logic lives in locale-shared.ts which is unit-tested.
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
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
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
