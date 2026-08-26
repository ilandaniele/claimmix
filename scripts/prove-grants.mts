/**
 * `pnpm permisos` — ¿el rol de la aplicación puede hacer lo que la capa le pide?
 *
 * La capa de datos pasó de leer a también escribir: los INSERT y UPDATE que
 * antes iban por el rol dueño ahora entran por `claimmix_app`. Un permiso que
 * falte no se descubre acá: se descubre en producción, cuando alguien manda un
 * WhatsApp y el mensaje no se guarda.
 *
 * Y falla de una manera particularmente fea. Casi todas esas escrituras están
 * adentro de un `try { } catch { }` que traga el error a propósito —un fallo al
 * registrar el uso de IA no puede tumbar una extracción—, así que un GRANT que
 * falte se ve como que la aplicación anda bien y no guarda nada.
 *
 * Esto pregunta al catálogo, no adivina. Sólo lee.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL_APP?.trim();
if (!url) {
  console.error("Falta DATABASE_URL_APP.");
  process.exit(2);
}

/**
 * Traducir el error del driver a algo accionable.
 *
 * "password authentication failed" sale como una excepción cruda con un stack
 * de veinte líneas del driver, y no dice ninguna de las dos cosas que hacen
 * falta: qué se rompió y cómo se arregla.
 */
function explicar(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/password authentication failed/i.test(msg)) {
    console.error("\n✗ La contraseña de DATABASE_URL_APP no autentica.");
    console.error("");
    console.error("  El rol existe; lo que no sirve es la contraseña guardada.");
    console.error("  Suele pasar después de rotarla en un lado y no en el otro.");
    console.error("");
    console.error("  1. pnpm rol-app --rotar        genera una nueva y la imprime");
    console.error("  2. pegala en .env.local");
    console.error("  3. vercel env rm DATABASE_URL_APP production");
    console.error("     vercel env add DATABASE_URL_APP production");
    process.exit(2);
  }
  throw e;
}

const rol = /:\/\/([^:]+):/.exec(url)?.[1] ?? "?";
const sql = neon(url);

console.log("═".repeat(70));
console.log(`PERMISOS — qué puede hacer "${rol}" sobre cada tabla`);
console.log("═".repeat(70));

/** Las tablas con columna de inquilino: las que la capa toca. */
const tablas = (await sql`
  select c.relname as tabla,
         c.relrowsecurity as rls,
         c.relforcerowsecurity as forzado
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0
    )
  order by c.relname
`.catch(explicar)) as Array<{ tabla: string; rls: boolean; forzado: boolean }>;

/**
 * Qué privilegios tiene el rol sobre cada una.
 *
 * `has_table_privilege` y no `information_schema.table_privileges`: la vista
 * lista sólo lo concedido directamente, y se pierde lo que llega por herencia
 * de otro rol. Ahí un permiso que existe aparece como faltante, y se termina
 * concediendo de nuevo algo que ya estaba.
 */
const faltantes: string[] = [];
const sinForzar: string[] = [];
const sinPolitica: string[] = [];

for (const t of tablas) {
  const [p] = (await sql`
    select
      has_table_privilege(${rol}, ${"public." + t.tabla}, 'SELECT') as leer,
      has_table_privilege(${rol}, ${"public." + t.tabla}, 'INSERT') as insertar,
      has_table_privilege(${rol}, ${"public." + t.tabla}, 'UPDATE') as actualizar,
      has_table_privilege(${rol}, ${"public." + t.tabla}, 'DELETE') as borrar,
      (select count(*)::int from pg_policies
        where schemaname = 'public' and tablename = ${t.tabla}) as politicas
  `) as Array<{
    leer: boolean;
    insertar: boolean;
    actualizar: boolean;
    borrar: boolean;
    politicas: number;
  }>;

  const falta = [
    !p.leer && "SELECT",
    !p.insertar && "INSERT",
    !p.actualizar && "UPDATE",
    !p.borrar && "DELETE",
  ].filter(Boolean) as string[];

  if (falta.length) faltantes.push(`${t.tabla}: le falta ${falta.join(", ")}`);
  if (!t.forzado) sinForzar.push(t.tabla);
  if (p.politicas === 0) sinPolitica.push(t.tabla);
}

console.log(`\n▸ ${tablas.length} tabla(s) con columna de inquilino`);

if (faltantes.length === 0) {
  console.log("   ✓ el rol puede leer, insertar, actualizar y borrar en todas");
} else {
  console.log(`   ✗ ${faltantes.length} con permisos incompletos:`);
  for (const f of faltantes) console.log(`      · ${f}`);
}

console.log("\n▸ RLS forzado");
if (sinForzar.length === 0) {
  console.log("   ✓ todas con FORCE ROW LEVEL SECURITY");
} else {
  // Sin FORCE, el dueño de la tabla se saltea sus propias políticas. Eso no es
  // un detalle: el dueño es quien corre las migraciones y las tareas de fondo.
  console.log(`   ✗ ${sinForzar.length} sin forzar: ${sinForzar.join(", ")}`);
}

console.log("\n▸ Políticas");
if (sinPolitica.length === 0) {
  console.log("   ✓ todas tienen al menos una");
} else {
  // Una tabla con RLS forzado y SIN política no filtra: niega todo. La
  // aplicación no ve una fuga, ve una tabla que quedó vacía de golpe.
  console.log(`   ✗ ${sinPolitica.length} sin ninguna: ${sinPolitica.join(", ")}`);
}

const problemas = faltantes.length + sinForzar.length + sinPolitica.length;
console.log("\n" + "─".repeat(70));
if (problemas === 0) {
  console.log("✓ El rol tiene exactamente lo que la capa necesita, y ni un poco más.");
  process.exit(0);
}
console.log(`✗ ${problemas} problema(s).`);
process.exit(1);
