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
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/lib/**", "src/server/**"],
      exclude: [
        // Type definition files
        "src/lib/supabase/types.ts",
        "**/*.d.ts",
        // Supabase client factories — require Next.js runtime (cookies(), etc.)
        // Covered by integration tests, not unit tests.
        "src/lib/supabase/browser.ts",
        "src/lib/supabase/server.ts",
        "src/lib/supabase/service.ts",
        // Observability — require Sentry DSN and pino runtime at module init.
        // Covered by manual/integration testing.
        "src/lib/observability/**",
        // Upstash rate-limit adapter — requires UPSTASH_* env vars at runtime.
        "src/lib/rate-limit/upstash.ts",
        // Email infrastructure — require Resend SDK API key and/or Supabase service-role
        // client at runtime. Covered by integration tests with mocked clients, not unit tests.
        "src/server/email/dispatch.ts",
        "src/server/email/resend-sender.ts",
        "src/server/email/thread-lookup.ts",
        // Idempotency check — Supabase service-role query, no testable branch logic beyond DB call.
        // Covered via integration tests (intake-email.test.ts AC3 path).
        "src/server/email/dedupe.ts",
        // AI budget guard — Supabase service-role queries against ai_usage table.
        // Requires live DB; covered by integration tests only. Same pattern as supabase/service.ts.
        "src/server/ai/budget.ts",
        // OpenAI SDK wrapper — requires OPENAI_API_KEY at runtime; same exclusion pattern as
        // upstash.ts. Core business logic (mock extractor) is covered at 100%.
        "src/server/ai/openai-extractor.ts",
        // Extraction worker orchestrator — pure DB-orchestration pipeline that wires budget,
        // extractor, customer-matcher, policy-matcher, and orchestrate together via Supabase
        // service-role calls. All constituent modules are individually unit-tested.
        // Covered end-to-end via integration tests (intake-email.test.ts, extractor-*.test.ts).
        "src/server/worker/extract.ts",
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
