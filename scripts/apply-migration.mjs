/**
 * Generic migration runner: applies one file from supabase/migrations/ to the
 * database in DATABASE_URL. Migrations must be idempotent (IF NOT EXISTS).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/apply-migration.mjs 0016_user_locale.sql
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import pg from "pg";

const fileArg = process.argv[2];
if (!fileArg) {
  console.error("Usage: node scripts/apply-migration.mjs <migration-file.sql>");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
// basename() prevents path traversal — only files inside supabase/migrations run.
const sql = readFileSync(
  join(here, "..", "supabase", "migrations", basename(fileArg)),
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
  console.log(`Migration ${basename(fileArg)} applied.`);
} catch (err) {
  try { await client.query("ROLLBACK"); } catch {}
  console.error("Migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
