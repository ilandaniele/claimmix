/**
 * `pnpm esquemas` — ¿los archivos de migración reproducen la base de verdad?
 *
 * Este proyecto tiene una historia con esto. Las migraciones se aplicaron a mano
 * durante meses, el registro de aplicadas se escribió con `--baseline` sin
 * ejecutar nada, y la 0010 figuró como aplicada durante dos días sin estarlo:
 * facturación devolvía 500 y dar de alta un cliente estaba roto. El registro
 * decía una cosa y la base otra.
 *
 * La única forma de saberlo es construir una base desde cero con los archivos y
 * compararla, columna por columna, contra la que está corriendo. Lo que aparezca
 * es drift: cambios hechos a mano que ningún archivo recuerda, o archivos que
 * describen algo que nunca llegó.
 *
 * Sólo lee de las dos bases. No escribe en ninguna.
 *
 * Uso:
 *   pnpm esquemas                     STAGING_DATABASE_URL contra DATABASE_URL
 *   pnpm esquemas --a X --b Y         dos variables cualesquiera del .env.local
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool, neonConfig } from "@neondatabase/serverless";

neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const arg = (n: string, def: string) => {
  const i = process.argv.indexOf(n);
  return i !== -1 ? process.argv[i + 1] : def;
};
const varA = arg("--a", "STAGING_DATABASE_URL");
const varB = arg("--b", "DATABASE_URL");
const urlA = process.env[varA]?.trim();
const urlB = process.env[varB]?.trim();

if (!urlA || !urlB) {
  console.error(`Faltan ${!urlA ? varA : ""} ${!urlB ? varB : ""} en .env.local`);
  process.exit(2);
}

// ── Qué se compara ──────────────────────────────────────────────────────────
//
// Cada consulta devuelve una lista de renglones de texto. Compararlos como
// texto es tosco a propósito: cualquier diferencia se ve, y no hay forma de que
// una diferencia "no importante" se cuele por un campo que olvidé mirar.
const CONSULTAS: Array<{ que: string; sql: string }> = [
  {
    que: "tablas",
    sql: `SELECT table_name::text
          FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'
          ORDER BY 1`,
  },
  {
    que: "columnas",
    sql: `SELECT (table_name || '.' || column_name || ' ' || data_type
                  || CASE WHEN is_nullable='NO' THEN ' NOT NULL' ELSE '' END
                  || COALESCE(' DEFAULT ' || column_default, ''))::text
          FROM information_schema.columns
          WHERE table_schema='public'
          ORDER BY table_name, column_name`,
  },
  {
    que: "índices",
    sql: `SELECT (tablename || ': ' || indexdef)::text
          FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`,
  },
  {
    que: "restricciones",
    sql: `SELECT (rel.relname || ': ' || con.conname || ' ' || pg_get_constraintdef(con.oid))::text
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname='public' ORDER BY 1`,
  },
  {
    que: "tipos enumerados",
    sql: `SELECT (t.typname || ' = ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder))::text
          FROM pg_type t
          JOIN pg_enum e ON e.enumtypid = t.oid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname='public' GROUP BY t.typname ORDER BY 1`,
  },
  {
    que: "funciones",
    sql: `SELECT (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' ORDER BY 1`,
  },
  {
    que: "políticas RLS",
    sql: `SELECT (tablename || '.' || policyname || ' ' || COALESCE(qual, '(sin condición)'))::text
          FROM pg_policies WHERE schemaname='public' ORDER BY tablename, policyname`,
  },
  {
    que: "estado de RLS",
    sql: `SELECT (c.relname || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity)::text
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`,
  },
];

const leer = async (pool: Pool, sql: string): Promise<string[]> => {
  const r = await pool.query(sql);
  return r.rows.map((f) => String(Object.values(f)[0]));
};

const poolA = new Pool({ connectionString: urlA });
const poolB = new Pool({ connectionString: urlB });

console.log("═".repeat(72));
console.log(`ESQUEMAS — ¿${varA} reproduce a ${varB}?`);
console.log("═".repeat(72));
console.log(`  A = ${varA}  (construida con los archivos de migración)`);
console.log(`  B = ${varB}  (la que está corriendo)`);

let diferencias = 0;

try {
  for (const { que, sql } of CONSULTAS) {
    const [a, b] = await Promise.all([leer(poolA, sql), leer(poolB, sql)]);
    const setA = new Set(a);
    const setB = new Set(b);
    const soloA = a.filter((x) => !setB.has(x));
    const soloB = b.filter((x) => !setA.has(x));

    if (soloA.length === 0 && soloB.length === 0) {
      console.log(`\n▸ ${que}: ✓ iguales (${a.length})`);
      continue;
    }

    diferencias += soloA.length + soloB.length;
    console.log(`\n▸ ${que}: ✗ ${soloA.length + soloB.length} diferencia(s)`);

    const mostrar = (titulo: string, lista: string[]) => {
      if (!lista.length) return;
      console.log(`   ${titulo} (${lista.length}):`);
      for (const x of lista.slice(0, 12)) console.log(`     · ${x}`);
      if (lista.length > 12) console.log(`     … y ${lista.length - 12} más`);
    };
    // "Sólo en los archivos" = algo que las migraciones crean y en producción
    // no está: una migración que nunca corrió.
    mostrar("sólo en los archivos (nunca llegó a la que corre)", soloA);
    // "Sólo en la que corre" = algo hecho a mano que ningún archivo recuerda.
    // Es lo más peligroso: se pierde el día que haya que reconstruir.
    mostrar("sólo en la que corre (ningún archivo lo recuerda)", soloB);
  }
} catch (e) {
  console.error(`\n✗ no se pudo comparar: ${(e as Error).message.slice(0, 200)}`);
  await poolA.end();
  await poolB.end();
  process.exit(2);
}

await poolA.end();
await poolB.end();

console.log("\n" + "─".repeat(72));
if (diferencias === 0) {
  console.log("✓ Los archivos de migración reproducen exactamente la base que corre.");
  console.log("  Se puede reconstruir desde cero sin perder nada.");
  process.exit(0);
}
console.log(`✗ ${diferencias} diferencia(s). Los archivos y la base no dicen lo mismo.`);
console.log("");
console.log("  Lo que está sólo en la que corre se pierde el día que haya que");
console.log("  reconstruir: no hay archivo que lo recuerde. Lo que está sólo en");
console.log("  los archivos es una migración que se dio por aplicada sin estarlo.");
process.exit(1);
