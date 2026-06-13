import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema/index.ts",
  // Tooling-only output dir; neon/migrations/0001_init.sql remains the
  // authoritative, hand-written migration.
  out: "./neon/drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
