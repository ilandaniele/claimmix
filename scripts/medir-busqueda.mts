/**
 * ¿La búsqueda de la bandeja usa los índices de trigramas cuando hay volumen?
 *
 * Siembra casos sintéticos en STAGING_DATABASE_URL y mide las dos consultas que
 * `listCases` corre con `q`, `consultaListado` y `consultaConteo`, como las
 * corre la app: por STAGING_DATABASE_URL_APP (claimmix_app), con el inquilino
 * puesto por RLS. Como dueño (BYPASSRLS) el plan es otro: bajo RLS `ilike` no
 * es leakproof y no baja como condición de índice.
 *
 * No toca producción. Limpia lo que sembró al terminar, incluso si algo falla.
 * No crea ni borra índices: los de la 0020 ya existen en el ensayo, y borrarlos
 * al limpiar los sacaba de verdad.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool, neonConfig } from "@neondatabase/serverless";
neonConfig.webSocketConstructor = globalThis.WebSocket as never;

import type { ClienteDatos } from "@/data/scope";
import { lineasDelPlan } from "./lib/chequeos-de-carga.mjs";

const url = process.env.STAGING_DATABASE_URL?.trim();
const app = process.env.STAGING_DATABASE_URL_APP?.trim();
if (!url || !app) {
  console.error("Faltan STAGING_DATABASE_URL y STAGING_DATABASE_URL_APP. Esto NO corre contra producción.");
  process.exit(2);
}

// La capa de datos, apuntada a la base de control del ensayo: ahí se siembra.
process.env.DATABASE_URL_APP = app;
process.env.BASE_POR_CLIENTE = "0";
const { enTenantVarias } = await import("@/data/scope");
const { consultaConteo, consultaListado } = await import("@/server/cases/list");
const { sql } = await import("drizzle-orm");

const CUANTOS = Number(process.argv[2] ?? 200_000);
const MARCA = "carga-sintetica-busqueda";
const pool = new Pool({ connectionString: url });
const cx = await pool.connect();

/** El tiempo que reporta EXPLAIN ANALYZE del listado y del conteo, y si entraron por un trigram. */
async function medir(tenantId: string, etiqueta: string, termino: string) {
  const query = { page: 1, per_page: 25, sort: "created_at", order: "desc", q: termino } as never;
  const ahora = new Date();
  const planes = await enTenantVarias<[unknown, unknown]>({ tenantId }, (d: ClienteDatos) => [
    d.execute(sql`explain analyze ${consultaListado(d, query, undefined, ahora).getSQL()}`),
    d.execute(sql`explain analyze ${consultaConteo(d, query, undefined, ahora).getSQL()}`),
  ]);
  const [listado, conteo] = planes.map((p) => {
    const texto = lineasDelPlan(p);
    const ms = Number(texto.match(/Execution Time: ([\d.]+) ms/)?.[1]);
    const nodo = /Index Scan on \w+_trgm/.test(texto)
      ? "trigram"
      : /Seq Scan on cases/.test(texto)
        ? "Seq Scan"
        : "otro";
    return { ms, nodo };
  });
  for (const [nombre, m] of [["listado", listado], ["conteo", conteo]] as const) {
    console.log(`   ${`${etiqueta}, ${nombre}`.padEnd(30)} ${m.ms.toFixed(1).padStart(9)} ms   ${m.nodo}`);
  }
  return listado;
}

try {
  const [{ id: tenant }] = (await cx.query(`select id from tenants limit 1`)).rows;
  const antes = (await cx.query(`select count(*)::int as n from cases`)).rows[0].n;
  console.log("═".repeat(70));
  console.log(`BÚSQUEDA — ¿usa los trigram con volumen y bajo RLS?`);
  console.log("═".repeat(70));
  console.log(`\nEn el ensayo hay ${antes} caso(s). Se van a sembrar ${CUANTOS.toLocaleString("es-AR")} más.`);

  console.log(`\n▸ Antes de sembrar`);
  await medir(tenant, "gonzalez", "gonzalez");

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

  console.log(`\n▸ Con ${total.toLocaleString("es-AR")} casos`);
  const raro = await medir(tenant, "término raro", "Apellido199999");
  await medir(tenant, "término frecuente", "Nombre42");

  console.log(`\n${"─".repeat(70)}`);
  if (raro.nodo === "trigram") {
    console.log(`✓ El listado entra por un trigram: ${raro.ms.toFixed(0)} ms.`);
  } else {
    console.log(`✗ El listado no entra por los trigram: ${raro.nodo}, ${raro.ms.toFixed(0)} ms.`);
    console.log(`  Bajo RLS un índice que necesita \`ilike\` como condición no se usa.`);
  }
} finally {
  console.log(`\n▸ Limpiando lo sembrado…`);
  const borradas = await cx.query(
    `delete from cases where channel = 'email_sim' and policy_number like 'POL-0%'`
  );
  const quedan = (await cx.query(`select count(*)::int as n from cases`)).rows[0].n;
  console.log(`   ${borradas.rowCount?.toLocaleString("es-AR")} borradas, quedan ${quedan}`);
  console.log(`   (${MARCA})`);
  cx.release();
  await pool.end();
}
