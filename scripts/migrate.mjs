/**
 * migrate.mjs — apply pending SQL migrations, and know which ones already ran.
 *
 *   node scripts/migrate.mjs                  # status: what is applied, what is pending
 *   node scripts/migrate.mjs --apply          # run every pending migration
 *   node scripts/migrate.mjs --baseline 0009  # record 0001..0009 as applied WITHOUT running them
 *
 * Why this exists: migrations here were applied by hand, with nothing recording
 * which ones had run. That is exactly what caused the 0006-0009 outage — those
 * three were written, never applied to prod, and every INSERT into `cases`
 * failed until someone diffed the live schema by hand. Migration 0010 was
 * sitting in the same position.
 *
 * THE FIRST RUN ON AN EXISTING DATABASE MUST BE `--baseline`. Migrations 0001
 * to 0009 are already applied to prod by hand; re-running them is at best a
 * no-op and at worst destructive. `--baseline 0009` writes those nine rows into
 * the ledger without executing a single statement, so the next `--apply` starts
 * cleanly at 0010.
 *
 * Safeguards:
 *   - Each migration runs inside its own transaction. A failure rolls that one
 *     back and stops the run, so the ledger never claims something half-applied.
 *   - Every applied migration's SHA-256 is stored. If a file is edited after it
 *     ran, the next run refuses to continue: the database and the repo have
 *     silently diverged, and guessing which is right is not this script's job.
 *   - Dry run by default, like every other script here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = "./neon/migrations";

const APPLY = process.argv.includes("--apply");
const baselineIdx = process.argv.indexOf("--baseline");
const BASELINE = baselineIdx !== -1 ? process.argv[baselineIdx + 1] : null;

if (BASELINE !== null && !/^\d{4}$/.test(BASELINE)) {
  console.error(`✖ --baseline expects a 4-digit version, e.g. --baseline 0009 (got "${BASELINE}")`);
  process.exit(1);
}

/**
 * Reads the migration files in execution order.
 *
 * Filenames must start with a zero-padded 4-digit version, which makes plain
 * lexicographic sort the correct execution order (this is why 0010 sorts after
 * 0009 rather than after 0001). Anything else in the directory is a mistake, so
 * it stops the run instead of being skipped silently.
 */
function readMigrations() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  const bad = files.filter((f) => !/^\d{4}_/.test(f));
  if (bad.length > 0) {
    console.error(`✖ these migration files do not start with a 4-digit version: ${bad.join(", ")}`);
    process.exit(1);
  }

  const seen = new Set();
  return files.map((filename) => {
    const version = filename.slice(0, 4);
    if (seen.has(version)) {
      console.error(`✖ duplicate migration version ${version}`);
      process.exit(1);
    }
    seen.add(version);

    const sql = readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
    return {
      version,
      filename,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  });
}

const env = readFileSync("./.env.local", "utf8");
const connMatch = env.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
if (!connMatch) {
  console.error("✖ DATABASE_URL not found in .env.local");
  process.exit(1);
}

const c = new pg.Client({ connectionString: connMatch[1], ssl: { rejectUnauthorized: false } });
await c.connect();

try {
  // The ledger bootstraps itself rather than living in a migration file —
  // otherwise the runner would need the very table it is trying to create.
  await c.query(`
    create table if not exists schema_migrations (
      version     text primary key,
      filename    text        not null,
      checksum    text        not null,
      applied_at  timestamptz not null default now(),
      applied_by  text
    )
  `);

  const migrations = readMigrations();
  const { rows: appliedRows } = await c.query(
    `select version, filename, checksum, applied_at from schema_migrations`
  );
  const applied = new Map(appliedRows.map((r) => [r.version, r]));

  // Drift check first: if the repo and the database disagree about what an
  // already-applied migration contained, nothing else this script says is
  // trustworthy.
  const drifted = migrations.filter(
    (m) => applied.has(m.version) && applied.get(m.version).checksum !== m.checksum
  );
  if (drifted.length > 0) {
    console.error("✖ DRIFT: these migrations were edited after being applied:");
    for (const m of drifted) console.error(`    ${m.filename}`);
    console.error("  The database and the repo have diverged. Resolve by hand;");
    console.error("  write a NEW migration rather than editing an applied one.");
    process.exit(1);
  }

  const pending = migrations.filter((m) => !applied.has(m.version));

  // ── Baseline ────────────────────────────────────────────────────────────
  if (BASELINE !== null) {
    const toAdopt = pending.filter((m) => m.version <= BASELINE);
    if (toAdopt.length === 0) {
      console.log(`Nada que adoptar hasta ${BASELINE}: ya están todas registradas.`);
      process.exit(0);
    }

    console.log(`ADOPTAR COMO YA APLICADAS (sin ejecutar), hasta ${BASELINE}:`);
    for (const m of toAdopt) console.log(`  ${m.filename}`);
    console.log();
    console.log("⚠ Sólo hacé esto si estas migraciones YA están aplicadas en esta base.");

    if (!APPLY) {
      console.log("\nDRY RUN — nada escrito. Repetí con --apply.");
      process.exit(0);
    }

    for (const m of toAdopt) {
      await c.query(
        `insert into schema_migrations (version, filename, checksum, applied_by)
         values ($1,$2,$3,$4)`,
        [m.version, m.filename, m.checksum, "baseline"]
      );
    }
    console.log(`\n✔ ${toAdopt.length} migraciones adoptadas. Corré --apply para las pendientes.`);
    process.exit(0);
  }

  // ── Status ──────────────────────────────────────────────────────────────
  console.log(`APLICADAS (${applied.size}):`);
  for (const m of migrations.filter((x) => applied.has(x.version))) {
    const when = applied.get(m.version).applied_at.toISOString().slice(0, 10);
    console.log(`  ✔ ${m.filename}   ${when}`);
  }
  if (applied.size === 0) console.log("  (ninguna)");

  console.log(`\nPENDIENTES (${pending.length}):`);
  for (const m of pending) console.log(`  · ${m.filename}`);
  if (pending.length === 0) {
    console.log("  (ninguna) — la base está al día.");
    process.exit(0);
  }

  // An empty ledger plus pending migrations on a database that clearly already
  // has tables means someone is about to re-run history. Refuse.
  if (applied.size === 0) {
    const { rows } = await c.query(
      `select count(*)::int n from information_schema.tables
        where table_schema = 'public' and table_name = 'cases'`
    );
    if (rows[0].n > 0) {
      console.error("\n✖ El registro está vacío pero la base ya tiene tablas.");
      console.error("  Esta base fue migrada a mano. Corré primero:");
      console.error("      node scripts/migrate.mjs --baseline <ultima-version-ya-aplicada> --apply");
      process.exit(1);
    }
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nada aplicado. Repetí con --apply para ejecutarlas.");
    process.exit(0);
  }

  // ── Apply ───────────────────────────────────────────────────────────────
  for (const m of pending) {
    process.stdout.write(`\n→ ${m.filename} ... `);
    try {
      await c.query("begin");
      await c.query(m.sql);
      await c.query(
        `insert into schema_migrations (version, filename, checksum, applied_by)
         values ($1,$2,$3,$4)`,
        [m.version, m.filename, m.checksum, "migrate.mjs"]
      );
      await c.query("commit");
      console.log("ok");
    } catch (e) {
      await c.query("rollback");
      console.log("FALLÓ");
      console.error(`\n✖ ${m.filename} falló y se revirtió por completo:`);
      console.error(`  ${e.message}`);
      console.error("\n  Las migraciones anteriores de esta corrida quedaron aplicadas.");
      console.error("  Arreglá el SQL y volvé a correr: sigue desde ésta.");
      process.exit(1);
    }
  }

  console.log(`\n✔ ${pending.length} migraciones aplicadas. La base está al día.`);
} finally {
  await c.end();
}
