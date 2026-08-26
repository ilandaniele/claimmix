/**
 * ¿Las políticas de RLS dejan usar los índices, o los anulan?
 *
 * Al mover el filtro por inquilino del SQL a la base, `tenant_id` desapareció
 * de los WHERE. Y muchos índices empiezan por esa columna:
 * `(tenant_id, created_at DESC)`. Si el predicado de la política no es
 * indexable, esos índices dejaron de servir el día del refactor — sin que nada
 * fallara, porque con pocas filas recorrer la tabla es más barato igual.
 *
 * La política es `claimmix_tenant_matches(tenant_id)`, o sea `f(columna)`. Eso
 * NO es indexable... salvo que Postgres inline la función, que al ser SQL y
 * STABLE es candidata. Inlineada queda `tenant_id = f()`, que sí lo es.
 *
 * Se mide sembrando de verdad. Corre contra el ensayo y limpia al terminar.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { Pool, neonConfig } from "@neondatabase/serverless";
neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const url = process.env.STAGING_DATABASE_URL?.trim();
const app = process.env.STAGING_DATABASE_URL_APP?.trim();
if (!url || !app) {
  console.error("Faltan STAGING_DATABASE_URL y STAGING_DATABASE_URL_APP.");
  process.exit(2);
}

const CUANTAS = Number(process.argv[2] ?? 300_000);
const dueno = new Pool({ connectionString: url });
const cx = await dueno.connect();

async function plan(pool: Pool, tenant: string, conFiltro: boolean) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('claimmix.tenant_id', $1, true)", [tenant]);
    const q = conFiltro
      ? `explain (analyze, format json) select coalesce(sum(cost_usd),0) from ai_usage
         where tenant_id = '${tenant}'::uuid and created_at >= now() - interval '30 days'`
      : `explain (analyze, format json) select coalesce(sum(cost_usd),0) from ai_usage
         where created_at >= now() - interval '30 days'`;
    const r = await c.query(q);
    await c.query("ROLLBACK");
    const p = r.rows[0]["QUERY PLAN"][0];
    const t = JSON.stringify(p.Plan);
    const nodo = /Index Scan|Index Only Scan/.test(t)
      ? "Index Scan"
      : /Bitmap/.test(t)
        ? "Bitmap"
        : "Seq Scan";
    return { ms: p["Execution Time"] as number, nodo };
  } finally {
    c.release();
  }
}

try {
  const { rows: inq } = await cx.query("select id from tenants limit 2");
  const [a, b] = inq.map((x) => x.id);
  console.log("═".repeat(70));
  console.log("RLS E ÍNDICES — ¿la política deja usar (tenant_id, created_at)?");
  console.log("═".repeat(70));

  console.log(`\n▸ Sembrando ${CUANTAS.toLocaleString("es-AR")} filas en ai_usage…`);
  const t0 = Date.now();
  await cx.query(
    `insert into ai_usage (tenant_id, model, prompt_tokens, completion_tokens, cost_usd, created_at)
     select case when g % 2 = 0 then $1::uuid else $2::uuid end,
            'gemini-2.5-flash', 1000, 200, 0.0012,
            now() - (g % 60 || ' days')::interval
     from generate_series(1, $3) g`,
    [a, b ?? a, CUANTAS]
  );
  await cx.query("analyze ai_usage");
  const { rows: n } = await cx.query("select count(*)::int as n from ai_usage");
  console.log(`   ${n[0].n.toLocaleString("es-AR")} filas, en ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const pApp = new Pool({ connectionString: app });
  try {
    console.log(`\n▸ Como la aplicación: sin filtro escrito, con RLS puesto`);
    const sinFiltro = await plan(pApp, a, false);
    console.log(`   ${sinFiltro.nodo.padEnd(12)} ${sinFiltro.ms.toFixed(1)} ms`);

    console.log(`\n▸ Con el filtro escrito a mano (como era antes del refactor)`);
    const conFiltro = await plan(pApp, a, true);
    console.log(`   ${conFiltro.nodo.padEnd(12)} ${conFiltro.ms.toFixed(1)} ms`);

    console.log(`\n${"─".repeat(70)}`);
    if (sinFiltro.nodo !== "Seq Scan") {
      console.log("✓ Postgres inlinea la política y usa el índice igual.");
      console.log("  El refactor no costó rendimiento.");
    } else if (conFiltro.nodo !== "Seq Scan") {
      const veces = sinFiltro.ms / conFiltro.ms;
      console.log(`✗ La política ANULA el índice: ${veces.toFixed(1)}× más lento.`);
      console.log(`  ${sinFiltro.ms.toFixed(0)} ms recorriendo, ${conFiltro.ms.toFixed(0)} ms por índice.`);
      console.log("  Hay que reescribir la política como `tenant_id = <expresión>`,");
      console.log("  que sí es indexable, en vez de `f(tenant_id)`.");
    } else {
      console.log("· Ninguna de las dos usa el índice: el problema es otro.");
    }
  } finally {
    await pApp.end();
  }
} finally {
  console.log(`\n▸ Limpiando…`);
  const r = await cx.query("delete from ai_usage where model = 'gemini-2.5-flash' and cost_usd = 0.0012");
  console.log(`   ${r.rowCount?.toLocaleString("es-AR")} filas borradas`);
  cx.release();
  await dueno.end();
}
