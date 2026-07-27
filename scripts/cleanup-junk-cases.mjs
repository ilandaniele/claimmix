/**
 * cleanup-junk-cases.mjs — remove cases with no analytical or training value.
 *
 *   node scripts/cleanup-junk-cases.mjs           # dry run, shows what would go
 *   node scripts/cleanup-junk-cases.mjs --apply   # actually delete
 *
 * ⚠️ Run scripts/export-training.mjs FIRST — the approved training set is the
 * only thing here that cannot be regenerated.
 *
 * Deletes cases that are ALL of:
 *   - not backing an approved training_example (those are hard-protected), and
 *   - in a dead-end status: no_relevante (classified as not a claim) or
 *     escalado (extraction failed and was never recovered), and
 *   - on an email/email_sim channel.
 *
 * Keeps: every case behind an approved example, anything still approvable
 * (confirmacion_pendiente / info_faltante / requiere_especialista /
 * listo_para_core), all WhatsApp cases, and anything mid-flight.
 *
 * Also repairs the phantom `is_claim = true` seeded at intake on cases the
 * extractor never actually classified.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const env = readFileSync("./.env.local", "utf8");
const conn = env.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)[1];
const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await c.connect();

const TARGET = `
  from cases cs
  where cs.channel in ('email','email_sim')
    and cs.status in ('no_relevante','escalado')
    and not exists (
      select 1 from training_examples te
       where te.case_id = cs.id and te.status = 'approved'
    )
`;

const before = (await c.query(`select count(*)::int n from cases`)).rows[0].n;
const doomed = (await c.query(`select cs.id ${TARGET}`)).rows.map((r) => r.id);
const breakdown = (await c.query(
  `select cs.channel, cs.status, count(*)::int n ${TARGET} group by cs.channel, cs.status order by n desc`
)).rows;

console.log(`Casos totales: ${before}`);
console.log(`A eliminar:    ${doomed.length}`);
console.log(`Quedan:        ${before - doomed.length}`);
console.table(breakdown);

// Sanity: nothing protected may be in the doomed set.
const protectedHit = (await c.query(
  `select count(*)::int n from training_examples where status='approved' and case_id = any($1::uuid[])`,
  [doomed]
)).rows[0].n;
console.log(`Chequeo de seguridad — training examples afectados: ${protectedHit} ${protectedHit === 0 ? "✅" : "❌ ABORTAR"}`);
if (protectedHit !== 0) { await c.end(); process.exit(1); }

if (!APPLY) {
  console.log("\n(dry run — nada borrado. Corré con --apply para ejecutar)");
  await c.end();
  process.exit(0);
}

// Every child table (raw_messages, claim_messages, extracted_fields,
// agent_runs, training_examples, ...) declares ON DELETE CASCADE on case_id, so
// deleting the parent is enough. audit_log has no FK to cases — its target_id
// is a loose uuid, deliberately left alone so the audit trail stays intact.
await c.query("BEGIN");
try {
  const del = await c.query(`delete from cases where id = any($1::uuid[])`, [doomed]);
  console.log(`  cases (+ hijos en cascada): ${del.rowCount}`);

  // Repair phantom is_claim on survivors the extractor never classified.
  const fixed = await c.query(`
    update cases cs set is_claim = null
     where cs.is_claim is not null
       and not exists (
         select 1 from agent_runs ar
          where ar.case_id = cs.id
            and (ar.output_payload->>'error_name') is null
       )
  `);
  console.log(`  is_claim fantasma reparado: ${fixed.rowCount}`);

  await c.query("COMMIT");
  const after = (await c.query(`select count(*)::int n from cases`)).rows[0].n;
  const te = (await c.query(`select count(*)::int n from training_examples where status='approved'`)).rows[0].n;
  console.log(`\n✅ Listo. Casos: ${before} -> ${after} | training examples aprobados intactos: ${te}`);
} catch (e) {
  await c.query("ROLLBACK");
  console.error("ROLLBACK:", e.message);
  process.exitCode = 1;
}
await c.end();
