/**
 * One-off runner: applies supabase/migrations/0015_tenant_ai_settings.sql to
 * the database in DATABASE_URL. Idempotent (IF NOT EXISTS guards).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/apply-migration-0015.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "supabase", "migrations", "0015_tenant_ai_settings.sql"),
  "utf8"
);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = 'tenant_ai_settings'`
  );
  console.log(
    rows.length === 1
      ? "Migration applied. Table present: tenant_ai_settings"
      : "Migration ran but table not found — check manually."
  );
} catch (err) {
  try { await client.query("ROLLBACK"); } catch {}
  console.error("Migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
