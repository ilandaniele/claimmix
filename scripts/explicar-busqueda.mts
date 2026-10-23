/**
 * Qué hace Postgres con la búsqueda de la bandeja.
 *
 * Explica las dos consultas que `listCases` corre con `q`, el listado y el
 * conteo, armadas por `consultaListado` y `consultaConteo` y corridas como la
 * app: por `DATABASE_URL_APP`, con el inquilino puesto por RLS. Como dueño
 * (BYPASSRLS) el plan es otro: bajo RLS `ilike` no es leakproof y no baja como
 * condición de índice, así que ahí los trigram de la 0020 no se usan.
 *
 * Sólo lee: EXPLAIN ANALYZE sobre SELECT. No escribe ni cambia nada.
 * Uso: pnpm explicar-busqueda [texto]
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";

import type { ClienteDatos } from "@/data/scope";
import { filasDe } from "./lib/chequeos-de-carga.mjs";

const url = process.env.DATABASE_URL?.trim();
if (!url) throw new Error("falta DATABASE_URL");
const T = process.env.GMAIL_TENANT_ID ?? "10000000-0000-0000-0000-000000000001";
const Q = process.argv[2] ?? "gonzalez";

// Después de dotenv: la capa de datos lee las cadenas de conexión del entorno.
const { baseDelInquilino, cadenaConBase } = await import("@/data/bases");
const { enTenantVarias } = await import("@/data/scope");
const { consultaConteo, consultaListado } = await import("@/server/cases/list");
const { sql: consulta } = await import("drizzle-orm");

// El catálogo, como dueño y en la misma base que la app: con BASE_POR_CLIENTE, la del inquilino.
const base = baseDelInquilino(T);
const sql = neon(base ? cadenaConBase(url, base) : url);

const [{ n }] = (await sql`select count(*)::int as n from cases`) as Array<{ n: number }>;
console.log(`casos en la tabla: ${n}`);

const query = { page: 1, per_page: 25, sort: "created_at", order: "desc", q: Q } as never;
const ahora = new Date();
const planes = await enTenantVarias<[unknown, unknown]>({ tenantId: T }, (d: ClienteDatos) => [
  d.execute(consulta`explain (analyze, buffers) ${consultaListado(d, query, undefined, ahora).getSQL()}`),
  d.execute(consulta`explain (analyze, buffers) ${consultaConteo(d, query, undefined, ahora).getSQL()}`),
]);

for (const [nombre, plan] of [["listado", planes[0]], ["conteo", planes[1]]] as const) {
  const lineas = filasDe(plan).map((f) => String(Object.values(f as Record<string, unknown>)[0]));
  console.log(`\n${nombre} con q = "${Q}", como claimmix_app:\n`);
  for (const l of lineas) console.log("  " + l);
  console.log(`  ${lineas.some((l) => l.includes("_trgm")) ? "usa" : "no usa"} los índices trigram`);
}

const [{ tiene }] = (await sql`
  select count(*)::int as tiene from pg_extension where extname = 'pg_trgm'
`) as Array<{ tiene: number }>;
console.log(`\npg_trgm instalado: ${tiene > 0 ? "sí" : "no"}`);

const idx = (await sql`
  select indexname from pg_indexes
  where tablename = 'cases' and (indexdef like '%trgm%' or indexdef like '%gin%')
`) as Array<{ indexname: string }>;
console.log(`índices de texto sobre cases: ${idx.length ? idx.map((i) => i.indexname).join(", ") : "ninguno"}`);
