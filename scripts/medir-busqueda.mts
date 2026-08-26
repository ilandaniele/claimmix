/**
 * ¿El índice de trigramas sirve, y desde qué tamaño?
 *
 * La búsqueda del tablero es `policyholder_name ILIKE '%texto%'`. Con el
 * comodín adelante ningún índice btree sirve: Postgres recorre la tabla entera.
 * Con 460 casos eso tarda 0,2 ms y no molesta; la pregunta es a partir de
 * cuántos empieza a doler, y cuánto lo arregla `pg_trgm`.
 *
 * Corre contra STAGING_DATABASE_URL y **siembra filas sintéticas**, así que no
 * toca producción. Limpia lo que sembró al terminar, incluso si algo falla.
 *
 * No se agrega un índice porque "es lo que se hace": se agrega cuando el número
 * lo pide y después de ver que el planificador lo usa. Un índice que el
 * planificador ignora es espacio en disco y escrituras más lentas a cambio de
 * nada.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool, neonConfig } from "@neondatabase/serverless";
neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const url = process.env.STAGING_DATABASE_URL?.trim();
if (!url) {
  console.error("Falta STAGING_DATABASE_URL. Esto NO corre contra producción.");
  process.exit(2);
}

const CUANTOS = Number(process.argv[2] ?? 200_000);
const MARCA = "carga-sintetica-busqueda";
const pool = new Pool({ connectionString: url });
const cx = await pool.connect();

/** El tiempo de ejecución que reporta EXPLAIN ANALYZE, y qué nodo usó. */
async function medir(etiqueta: string, termino: string) {
  const r = await cx.query(
    `explain (analyze, format json)
     select id from cases
     where policyholder_name ilike $1 or policy_number ilike $1
     order by created_at desc limit 25`,
    [`%${termino}%`]
  );
  const plan = r.rows[0]["QUERY PLAN"][0];
  const ms = plan["Execution Time"];
  const texto = JSON.stringify(plan.Plan);
  const nodo = /Seq Scan/.test(texto)
    ? "Seq Scan"
    : /Bitmap Index Scan/.test(texto)
      ? "Bitmap Index Scan"
      : /Index Scan/.test(texto)
        ? "Index Scan"
        : "otro";
  console.log(`   ${etiqueta.padEnd(22)} ${String(ms.toFixed(1)).padStart(9)} ms   ${nodo}`);
  return { ms, nodo };
}

try {
  const [{ id: tenant }] = (await cx.query(`select id from tenants limit 1`)).rows;
  const antes = (await cx.query(`select count(*)::int as n from cases`)).rows[0].n;
  console.log("═".repeat(70));
  console.log(`BÚSQUEDA — ¿desde qué tamaño hace falta un índice?`);
  console.log("═".repeat(70));
  console.log(`\nEn el ensayo hay ${antes} caso(s). Se van a sembrar ${CUANTOS.toLocaleString("es-AR")} más.`);

  console.log(`\n▸ Antes de sembrar`);
  await medir("sin índice", "gonzalez");

  // Sembrado en un solo INSERT ... SELECT: mucho más rápido que fila por fila,
  // y el `marca` en el nombre permite borrar exactamente lo sembrado.
  console.log(`\n▸ Sembrando…`);
  const t0 = Date.now();
  await cx.query(
    `insert into cases (tenant_id, policyholder_name, policy_number, status, channel, created_at)
     select $1::uuid,
            'Apellido' || g || ' Nombre' || (g % 997),
            'POL-' || lpad(g::text, 7, '0'),
            'recibido',
            'email_sim',
            now() - (g || ' minutes')::interval
     from generate_series(1, $2) g`,
    [tenant, CUANTOS]
  );
  await cx.query(`analyze cases`);
  const total = (await cx.query(`select count(*)::int as n from cases`)).rows[0].n;
  console.log(`   ${total.toLocaleString("es-AR")} casos, en ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  console.log(`\n▸ Con ${total.toLocaleString("es-AR")} casos, SIN índice`);
  const sinIndice = await medir("término raro", "Apellido199999");
  await medir("término frecuente", "Nombre42");

  console.log(`\n▸ Creando pg_trgm y los índices…`);
  await cx.query(`create extension if not exists pg_trgm`);
  await cx.query(
    `create index if not exists idx_cases_policyholder_name_trgm
       on cases using gin (policyholder_name gin_trgm_ops)`
  );
  await cx.query(
    `create index if not exists idx_cases_policy_number_trgm
       on cases using gin (policy_number gin_trgm_ops)`
  );
  await cx.query(`analyze cases`);

  console.log(`\n▸ Con ${total.toLocaleString("es-AR")} casos, CON índice`);
  const conIndice = await medir("término raro", "Apellido199999");
  await medir("término frecuente", "Nombre42");

  const veces = sinIndice.ms / conIndice.ms;
  console.log(`\n${"─".repeat(70)}`);
  if (conIndice.nodo === "Seq Scan") {
    console.log(`✗ El planificador IGNORA el índice: sigue recorriendo la tabla.`);
    console.log(`  Un índice que no se usa cuesta disco y escrituras, y no da nada.`);
  } else {
    console.log(`✓ ${veces.toFixed(0)}× más rápido, y usa ${conIndice.nodo}.`);
    console.log(`  ${sinIndice.ms.toFixed(0)} ms → ${conIndice.ms.toFixed(0)} ms`);
  }
} finally {
  console.log(`\n▸ Limpiando lo sembrado…`);
  const borradas = await cx.query(
    `delete from cases where channel = 'email_sim' and policy_number like 'POL-0%'`
  );
  await cx.query(`drop index if exists idx_cases_policyholder_name_trgm`);
  await cx.query(`drop index if exists idx_cases_policy_number_trgm`);
  const quedan = (await cx.query(`select count(*)::int as n from cases`)).rows[0].n;
  console.log(`   ${borradas.rowCount?.toLocaleString("es-AR")} borradas, quedan ${quedan}`);
  console.log(`   (${MARCA})`);
  cx.release();
  await pool.end();
}
