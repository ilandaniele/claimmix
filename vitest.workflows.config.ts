/**
 * Los tests de flujos durables, aparte de los demás.
 *
 * Necesitan su propia configuración porque el plugin `workflow()` compila las
 * directivas `"use workflow"` / `"use step"` y levanta un runtime en proceso.
 * Sin él, esas directivas son texto muerto: la función corre como cualquier
 * otra, el test pasa, y lo que se probó no es lo que va a correr en producción.
 *
 * Se corren con `pnpm flujos`.
 */
import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ["tests/workflows/**/*.test.ts"],
    // Un flujo encola cada paso en su propia petición, aunque sea en proceso.
    // El tiempo por omisión de vitest no alcanza.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "server-only": resolve(__dirname, "./tests/mocks/server-only.ts"),
    },
  },
});
