/**
 * create-tenant.mjs — onboard a new insurer or broker.
 *
 *   node scripts/create-tenant.mjs --name "La Segunda" --plan operativo \
 *        --contact ops@lasegunda.com.ar
 *   node scripts/create-tenant.mjs --name "La Segunda" --plan operativo --apply
 *
 * Dry run by default, like every other script here: it prints exactly what it
 * would insert and exits without writing.
 *
 * Why a script and not a UI: until now there was NO way to create a tenant
 * anywhere in the codebase — the first paying client would have meant
 * hand-written SQL against production Neon. This is the smallest thing that
 * removes that risk, and it applies the plan's commercial terms from the price
 * list so nobody has to remember them.
 *
 * Flags:
 *   --name <s>       required, the client's display name
 *   --plan <s>       piloto (default) | operativo | profesional | corporativo | enterprise
 *   --contact <s>    billing contact email
 *   --fee <n>        override the plan's monthly fee (USD)
 *   --included <n>   override the plan's included claims
 *   --overage <n>    override the plan's per-claim overage price (USD)
 *   --trial-days <n> for piloto: when the trial ends (default 60)
 *   --apply          actually write
 *
 * After creating a tenant you still have to let its people IN: add their
 * addresses (or @domain) to SIGNUP_ALLOWED_EMAILS in Vercel, otherwise
 * provisionUserProfile refuses the signup by design. The script prints the
 * exact line to add.
 */
import { readFileSync } from "node:fs";
import { connect } from "./lib/db-driver.mjs";

// Mirrors src/lib/billing/plans.ts. Duplicated deliberately: this script is
// plain .mjs run outside the Next build and cannot import the TS module.
const CATALOG = {
  piloto: { fee: 0, included: 300, overage: 0, status: "trial" },
  operativo: { fee: 390, included: 750, overage: 0.45, status: "active" },
  profesional: { fee: 1100, included: 3000, overage: 0.35, status: "active" },
  corporativo: { fee: 2900, included: 10000, overage: 0.28, status: "active" },
  enterprise: { fee: 2900, included: 10000, overage: 0.2, status: "active" },
};

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function numArg(flag, fallback) {
  const raw = arg(flag);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`✖ ${flag} must be a non-negative number, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

const APPLY = process.argv.includes("--apply");
const name = arg("--name");
const plan = arg("--plan", "piloto");
const contact = arg("--contact");

if (!name) {
  console.error("✖ --name is required.  e.g. --name \"La Segunda\" --plan operativo");
  process.exit(1);
}
if (!CATALOG[plan]) {
  console.error(`✖ unknown plan "${plan}". One of: ${Object.keys(CATALOG).join(", ")}`);
  process.exit(1);
}
// A billing contact that is not an email address is a silent invoicing failure.
if (contact && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) {
  console.error(`✖ --contact "${contact}" is not a valid email address`);
  process.exit(1);
}

const base = CATALOG[plan];
const fee = numArg("--fee", base.fee);
const included = Math.floor(numArg("--included", base.included));
const overage = numArg("--overage", base.overage);
const trialDays = Math.floor(numArg("--trial-days", 60));

const trialEnds =
  plan === "piloto" ? new Date(Date.now() + trialDays * 86_400_000).toISOString() : null;
const activatedAt = plan === "piloto" ? null : new Date().toISOString();

console.log("TENANT A CREAR:");
console.log(`  nombre         ${name}`);
console.log(`  plan           ${plan}  (${base.status})`);
console.log(`  abono          USD ${fee.toFixed(2)}/mes`);
console.log(`  incluidos      ${included} siniestros/mes`);
console.log(`  excedente      USD ${overage.toFixed(4)} c/u`);
console.log(`  contacto       ${contact ?? "(sin definir)"}`);
if (trialEnds) console.log(`  piloto hasta   ${trialEnds.slice(0, 10)}  (${trialDays} días)`);
console.log();

const env = readFileSync("./.env.local", "utf8");
const conn = env.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)[1];
const c = await connect(conn);

try {
  // Migration 0010 must be applied first — these columns are hand-applied in
  // this project, so check rather than fail halfway through an INSERT.
  const { rows: cols } = await c.query(
    `select column_name from information_schema.columns
      where table_name = 'tenants' and column_name = 'plan'`
  );
  if (cols.length === 0) {
    console.error("✖ tenants.plan does not exist — apply neon/migrations/0010_tenant_commercial_terms.sql first.");
    process.exit(1);
  }

  const { rows: dupe } = await c.query(`select id from tenants where lower(name) = lower($1)`, [
    name,
  ]);
  if (dupe.length > 0) {
    console.error(`✖ a tenant named "${name}" already exists (${dupe[0].id}). Refusing to create a second.`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log("DRY RUN — nada escrito. Repetí con --apply para crearlo.");
    process.exit(0);
  }

  const { rows } = await c.query(
    `insert into tenants
       (name, plan, billing_status, monthly_fee_usd, included_claims,
        overage_price_usd, contact_email, trial_ends_at, activated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id, created_at`,
    [name, plan, base.status, fee, included, overage, contact, trialEnds, activatedAt]
  );

  const id = rows[0].id;
  console.log(`✔ tenant creado: ${id}`);
  console.log();
  console.log("PASOS QUE FALTAN (no los hace este script):");
  console.log(`  1. Dejar entrar a su gente — agregar en Vercel a SIGNUP_ALLOWED_EMAILS:`);
  console.log(`       ${contact ? contact : "@dominio-del-cliente.com"}`);
  console.log(`     Sin esto el alta por Google se rechaza a propósito.`);
  console.log(`  2. Que un admin del cliente cargue SU propia Gemini API key en Configuración`);
  console.log(`     (resolución user → tenant → env: paga su propio consumo).`);
  console.log(`  3. Facturación del mes: GET /api/admin/billing?month=YYYY-MM`);
  console.log();
  console.log(`  TENANT_ID=${id}`);
} finally {
  await c.end();
}
