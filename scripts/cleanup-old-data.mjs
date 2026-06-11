/**
 * One-off production cleanup (2026-06-10) — removes stale pre-launch data:
 *
 *   1. ALL gmail_poll_state rows — one is malformed (email stored with literal
 *      quotes), the other carries the watermark/watch of the expired OAuth
 *      token. Fresh state is auto-created on the next poll (first-run path).
 *   2. The "Sentinel MVP" junk tenant (00000000-0000-0000-0000-000000000000),
 *      created accidentally before GMAIL_TENANT_ID was configured. The real
 *      tenant ("Mi Aseguradora", 10000000-...-0001) is untouched.
 *   3. With --include-audit: all audit_log rows (103 old test events).
 *      Off by default — wiping the audit trail is your call.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/cleanup-old-data.mjs [--include-audit]
 */

import pg from "pg";

const includeAudit = process.argv.includes("--include-audit");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  await client.query("BEGIN");

  const pollState = await client.query("DELETE FROM public.gmail_poll_state");
  console.log(`gmail_poll_state: ${pollState.rowCount} stale rows deleted`);

  const tenant = await client.query(
    "DELETE FROM public.tenants WHERE id = '00000000-0000-0000-0000-000000000000'"
  );
  console.log(`sentinel junk tenant: ${tenant.rowCount} deleted`);

  if (includeAudit) {
    const audit = await client.query("DELETE FROM public.audit_log");
    console.log(`audit_log: ${audit.rowCount} old test events deleted`);
  } else {
    console.log("audit_log: skipped (pass --include-audit to wipe old test events)");
  }

  await client.query("COMMIT");

  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM public.tenants)::int   AS tenants,
            (SELECT count(*) FROM public.users)::int     AS users,
            (SELECT count(*) FROM public.gmail_poll_state)::int AS poll_state,
            (SELECT count(*) FROM public.audit_log)::int AS audit_log`
  );
  console.log("after:", JSON.stringify(rows[0]));
} catch (err) {
  try { await client.query("ROLLBACK"); } catch {}
  console.error("Cleanup failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
