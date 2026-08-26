/**
 * Qué hace Postgres con la búsqueda del tablero.
 *
 * Sólo lee: EXPLAIN ANALYZE sobre un SELECT. No escribe ni cambia nada.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL?.trim();
if (!url) throw new Error("falta DATABASE_URL");
const sql = neon(url);
const T = process.env.GMAIL_TENANT_ID ?? "10000000-0000-0000-0000-000000000001";

const [{ n }] = (await sql`select count(*)::int as n from cases`) as Array<{ n: number }>;
console.log(`casos en la tabla: ${n}\n`);

const plan = (await sql`
  explain (analyze, buffers, format text)
  select id from cases
  where tenant_id = ${T}::uuid
    and (policyholder_name ilike '%gonzalez%' or policy_number ilike '%gonzalez%')
  order by created_at desc limit 25
`) as Array<Record<string, string>>;

for (const fila of plan) console.log("  " + Object.values(fila)[0]);

const [{ tiene }] = (await sql`
  select count(*)::int as tiene from pg_extension where extname = 'pg_trgm'
`) as Array<{ tiene: number }>;
console.log(`\npg_trgm instalado: ${tiene > 0 ? "sí" : "no"}`);

const idx = (await sql`
  select indexname from pg_indexes
  where tablename = 'cases' and (indexdef like '%trgm%' or indexdef like '%gin%')
`) as Array<{ indexname: string }>;
console.log(`índices de texto sobre cases: ${idx.length ? idx.map((i) => i.indexname).join(", ") : "ninguno"}`);
