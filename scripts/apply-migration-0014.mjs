/**
 * One-off runner: applies supabase/migrations/0014_agent_learning.sql to the
 * database in DATABASE_URL. Idempotent (the migration uses IF NOT EXISTS).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node --experimental-strip-types scripts/apply-migration-0014.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "supabase", "migrations", "0014_agent_learning.sql"), "utf8");

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
     WHERE table_schema='public'
       AND table_name IN ('agent_runs','training_examples','agent_feedback',
                          'agent_prompt_rules','prompt_versions','model_training_jobs')
     ORDER BY table_name`
  );
  console.log("Migration applied. Tables present:", rows.map((r) => r.table_name).join(", "));
} catch (err) {
  try { await client.query("ROLLBACK"); } catch {}
  console.error("Migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
