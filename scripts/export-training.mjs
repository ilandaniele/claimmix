/**
 * export-training.mjs — dump the approved training set to a portable JSON file.
 *
 *   node scripts/export-training.mjs [outfile]
 *
 * Writes training-export/training-examples-<date>.json containing every
 * approved training_example (input + expected output + metadata). This is the
 * asset that survives database cleanups and can be re-imported or fed straight
 * into a fine-tuning run, so run it BEFORE deleting anything.
 *
 * Companion: scripts/import-training.mjs restores a dump into an empty DB.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import pg from "pg";

const env = readFileSync("./.env.local", "utf8");
const conn = env.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)[1];
const outDir = "training-export";
const stamp = new Date().toISOString().slice(0, 10);
const outFile = process.argv[2] || `${outDir}/training-examples-${stamp}.json`;

const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await c.connect();

const examples = (await c.query(`
  select te.id, te.tenant_id, te.claim_type, te.input_payload, te.expected_output,
         te.status, te.approved_at, cs.channel
    from training_examples te
    left join cases cs on cs.id = te.case_id
   where te.status = 'approved'
   order by te.claim_type, te.approved_at
`)).rows;

const rules = (await c.query(`
  select id, tenant_id, title, rule_text, rule_type, active, created_at
    from agent_prompt_rules
   order by created_at
`)).rows;

const byType = {};
for (const e of examples) byType[e.claim_type ?? "(null)"] = (byType[e.claim_type ?? "(null)"] || 0) + 1;

const payload = {
  exported_at: new Date().toISOString(),
  source: "claimmix",
  counts: { total: examples.length, by_claim_type: byType, prompt_rules: rules.length },
  training_examples: examples,
  prompt_rules: rules,
};

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");

console.log(`✅ Exportado: ${outFile}`);
console.log(`   ejemplos aprobados: ${examples.length}`);
console.log(`   prompt rules: ${rules.length}`);
console.table(Object.entries(byType).map(([claim_type, n]) => ({ claim_type, n })));
await c.end();
