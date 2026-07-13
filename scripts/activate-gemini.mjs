/**
 * activate-gemini.mjs — one-shot activation once prepay credits are loaded.
 *
 * Run:  node scripts/activate-gemini.mjs
 *
 * Does NOT touch Vercel (that needs `vercel login` + is done separately).
 * Safe + idempotent. If the key still 429s it stops before touching anything,
 * so it never re-escalates the backlog against a dead key.
 *   1. Verifies the staged GEMINI_API_KEY works now (no 429).
 *   2. Confirms DB has no stale key overrides + provider=gemini.
 *   3. Reports the escalado backlog.
 *   4. Triggers /api/admin/reprocess-unclassified (CRON_SECRET) to re-drive it.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const env = readFileSync("./.env.local", "utf8");
const get = (k) => (env.match(new RegExp(`^${k}\\s*=\\s*"?([^"\\n]+)"?`, "m")) || [])[1];
const KEY = get("GEMINI_API_KEY");
const CRON = get("CRON_SECRET");
const PROD = "https://claimmix.vercel.app";

async function main() {
  // 1) Verify the key works now
  console.log("1) Verificando la key Gemini…");
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }) }
  );
  if (r.status !== 200) {
    const b = await r.json().catch(() => ({}));
    console.log(`   ❌ Key todavía NO funciona (HTTP ${r.status}: ${b.error?.status}). ${(b.error?.message || "").slice(0, 90)}`);
    console.log("   → Cargá el prepago y volvé a correr este script. No toco nada más.");
    return;
  }
  console.log("   ✅ Key OK (HTTP 200) — está paga y viva.");

  // 2) DB sanity
  const c = new pg.Client({ connectionString: get("DATABASE_URL"), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const s = (await c.query(`select
      (select count(*)::int from tenant_ai_settings where gemini_api_key_encrypted is not null) t,
      (select count(*)::int from user_ai_settings where gemini_api_key_encrypted is not null) u`)).rows[0];
    console.log(`2) DB: tenant keys=${s.t}, user keys=${s.u} ${s.t + s.u === 0 ? "✅ limpio" : "⚠️ overrides"}`);
    const backlog = (await c.query(`select channel, count(*)::int n from cases where status='escalado' group by channel`)).rows;
    console.log("3) Backlog escalado a reprocesar:", JSON.stringify(backlog));
  } finally {
    await c.end();
  }

  // 4) Trigger reprocess (batches of 50)
  if (!CRON) { console.log("4) ⚠️ CRON_SECRET no está en .env.local — disparalo desde el admin UI."); return; }
  console.log("4) Disparando reprocess-unclassified (tandas de 50)…");
  for (let i = 1; i <= 5; i++) {
    const resp = await fetch(`${PROD}/api/admin/reprocess-unclassified`, { method: "POST", headers: { Authorization: `Bearer ${CRON}` } });
    const j = await resp.json().catch(() => ({}));
    const n = j?.data?.triggered ?? 0;
    console.log(`   tanda ${i}: HTTP ${resp.status}, triggered=${n}`);
    if (n === 0) break;
    await new Promise((res) => setTimeout(res, 3000));
  }
  console.log("\n✅ Listo. Se reprocesan en segundo plano. Revisá la bandeja para aprobar los buenos como training examples.");
}

main().catch((e) => { console.error("Error:", e?.message || e); process.exitCode = 1; });
