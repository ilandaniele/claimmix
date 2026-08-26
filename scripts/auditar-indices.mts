/**
 * `pnpm indices` — qué tablas se consultan y con qué las está resolviendo.
 *
 * Postgres lleva la cuenta: cuántas veces se recorrió una tabla entera
 * (`seq_scan`), cuántas se entró por un índice (`idx_scan`), y cuántas filas
 * costó cada cosa. Con eso se ve dónde falta un índice sin adivinar.
 *
 * Una tabla chica recorrida entera no es un problema —el planificador elige
 * bien— así que lo que se mira no es el número de recorridos sino **cuántas
 * filas se leyeron para descartarlas**. Ahí está el costo que crece.
 *
 * Sólo lee.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!.trim());

const filas = (await sql`
  select relname as tabla,
         n_live_tup::int as filas,
         coalesce(seq_scan, 0)::int as recorridos,
         coalesce(seq_tup_read, 0)::bigint as filas_leidas_recorriendo,
         coalesce(idx_scan, 0)::int as por_indice
  from pg_stat_user_tables
  where n_live_tup > 0
  order by coalesce(seq_tup_read, 0) desc
  limit 12
`) as Array<{
  tabla: string;
  filas: number;
  recorridos: number;
  filas_leidas_recorriendo: string;
  por_indice: number;
}>;

console.log("═".repeat(78));
console.log("ÍNDICES — qué se recorre entero y cuánto cuesta");
console.log("═".repeat(78));
console.log("");
console.log("  tabla                    filas   recorridos  filas leídas    por índice");
console.log("  " + "─".repeat(74));

const sospechosas: string[] = [];
for (const f of filas) {
  const leidas = Number(f.filas_leidas_recorriendo);
  // Lo que importa: cuántas filas se leyeron de más por recorrido. Una tabla de
  // 400 filas recorrida mil veces son 400.000 filas leídas y no molesta hoy;
  // con 400.000 filas, el mismo patrón son 400 millones.
  const porRecorrido = f.recorridos > 0 ? Math.round(leidas / f.recorridos) : 0;
  const marca = porRecorrido > 1000 ? "  ← mirar" : "";
  if (porRecorrido > 1000) sospechosas.push(`${f.tabla} (${porRecorrido} filas por recorrido)`);
  console.log(
    `  ${f.tabla.padEnd(24)} ${String(f.filas).padStart(6)}  ${String(f.recorridos).padStart(10)}  ${String(leidas).padStart(12)}  ${String(f.por_indice).padStart(10)}${marca}`
  );
}

// ── Índices que existen y nadie usa ─────────────────────────────────────────
//
// Un índice sin uso no es gratis: se actualiza en cada INSERT y en cada UPDATE
// de su columna. Vale la pena saber cuáles son antes de agregar más.
const dormidos = (await sql`
  select indexrelname as indice, relname as tabla
  from pg_stat_user_indexes
  where idx_scan = 0 and indexrelname not like '%_pkey'
  order by relname, indexrelname
`) as Array<{ indice: string; tabla: string }>;

console.log("");
if (dormidos.length === 0) {
  console.log("▸ Todos los índices se usan.");
} else {
  console.log(`▸ ${dormidos.length} índice(s) sin un solo uso desde el último reinicio:`);
  for (const d of dormidos) console.log(`     ${d.tabla}.${d.indice}`);
  console.log("");
  console.log("  No siempre sobran: uno recién creado todavía no se usó, y otro puede");
  console.log("  cubrir una consulta que corre una vez por mes. Pero conviene mirarlos");
  console.log("  antes de agregar más, porque cada uno cuesta en cada escritura.");
}

console.log("");
console.log("─".repeat(78));
if (sospechosas.length === 0) {
  console.log("✓ Ninguna tabla se recorre entera de una forma que escale mal.");
} else {
  console.log(`▸ ${sospechosas.length} para mirar: ${sospechosas.join(", ")}`);
}
