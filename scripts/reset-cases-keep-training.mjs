/**
 * reset-cases-keep-training.mjs — wipe every case, keep the trained agent.
 *
 *   node scripts/reset-cases-keep-training.mjs           # dry run
 *   node scripts/reset-cases-keep-training.mjs --apply   # do it
 *
 * ⚠️ Run scripts/export-training.mjs first.
 *
 * The catch this solves: training_examples is reachable from cases by TWO
 * cascading paths —
 *     cases --CASCADE--> training_examples          (case_id)
 *     cases --CASCADE--> agent_runs --CASCADE--> training_examples (agent_run_id)
 * so a plain `DELETE FROM cases` silently destroys the whole training set.
 *
 * Both case_id columns are nullable, so we detach first: null out
 * training_examples.case_id and agent_runs.case_id for the runs that back an
 * approved example. Those rows then survive the delete, and the few-shot layer
 * (loadApprovedExamples) keeps working — it selects on tenant/status/claim_type
 * and never reads case_id.
 *
 * Kept: approved training_examples, their agent_runs, agent_prompt_rules,
 * users, tenants, customers, policies, gmail accounts.
 * Deleted: every case and its non-training children.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const env = readFileSync("./.env.local", "utf8");
const conn = env.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)[1];
const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await c.connect();

const n = async (q) => Number((await c.query(q)).rows[0].n);
const before = {
  cases: await n(`select count(*)::int n from cases`),
  approved: await n(`select count(*)::int n from training_examples where status='approved'`),
  rules: await n(`select count(*)::int n from agent_prompt_rules`),
  runsBacking: await n(`
    select count(*)::int n from agent_runs ar
     where exists (select 1 from training_examples te
                    where te.agent_run_id = ar.id and te.status='approved')`),
};

console.log("ANTES:");
console.log(`  casos:                       ${before.cases}`);
console.log(`  training aprobado:           ${before.approved}`);
console.log(`  prompt rules:                ${before.rules}`);
console.log(`  agent_runs que lo respaldan: ${before.runsBacking}`);
console.log(`\nSe borrarán ${before.cases} casos; el entrenamiento se desacopla y sobrevive.`);

if (!APPLY) {
  console.log("\n(dry run — nada borrado. Corré con --apply)");
  await c.end();
  process.exit(0);
}

await c.query("BEGIN");
try {
  // 1. Detach the training set from the cases about to be deleted.
  const d1 = await c.query(`update training_examples set case_id = null where case_id is not null`);
  console.log(`\n  training_examples desacoplados: ${d1.rowCount}`);

  const d2 = await c.query(`
    update agent_runs set case_id = null
     where case_id is not null
       and exists (select 1 from training_examples te
                    where te.agent_run_id = agent_runs.id and te.status='approved')`);
  console.log(`  agent_runs preservados:        ${d2.rowCount}`);

  // 2. Drop every case. Remaining children cascade; the detached rows do not.
  const del = await c.query(`delete from cases`);
  console.log(`  casos borrados:                ${del.rowCount}`);

  // 3. Verify BEFORE committing — roll back if the training set moved at all.
  const after = {
    cases: await n(`select count(*)::int n from cases`),
    approved: await n(`select count(*)::int n from training_examples where status='approved'`),
    rules: await n(`select count(*)::int n from agent_prompt_rules`),
  };
  if (after.approved !== before.approved || after.rules !== before.rules) {
    throw new Error(
      `verificación falló: training ${before.approved}->${after.approved}, rules ${before.rules}->${after.rules}`
    );
  }

  await c.query("COMMIT");
  console.log("\nDESPUÉS:");
  console.log(`  casos:             ${after.cases}`);
  console.log(`  training aprobado: ${after.approved} ✅ intacto`);
  console.log(`  prompt rules:      ${after.rules} ✅ intacto`);
  console.log("\n✅ Base limpia, agente entrenado.");
} catch (e) {
  await c.query("ROLLBACK");
  console.error("❌ ROLLBACK —", e.message);
  process.exitCode = 1;
}
await c.end();
