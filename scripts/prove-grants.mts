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
 *
 * Uso:
 *   pnpm permisos                                  el perfil único, contra DATABASE_URL_APP
 *   pnpm permisos --perfil cliente --base t_<hex>  la base de un cliente (BASE_POR_CLIENTE)
 *   pnpm permisos --perfil control                 la base de control
 *
 * Los perfiles son los de `scripts/lib/permisos-por-perfil.mjs`. `--base` cambia
 * sólo el nombre de la base en la cadena de DATABASE_URL_APP.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { cadenaConBase } from "@/data/bases";
import {
  ESPEJADAS_DE_SOLO_LECTURA,
  TABLAS_DE_CONTROL,
  TABLAS_SOLO_DE_CONTROL,
} from "./lib/permisos-por-perfil.mjs";
import { PERMISOS_POR_COLUMNA, PERMISOS_QUITADOS } from "./lib/permisos-quitados.mjs";

const argumento = (nombre: string) => {
  const i = process.argv.indexOf(nombre);
  return i === -1 ? null : (process.argv[i + 1] ?? "");
};
const PERFIL = argumento("--perfil") ?? "unico";
const BASE = argumento("--base");
if (!["unico", "cliente", "control"].includes(PERFIL)) {
  console.error(`--perfil espera unico, cliente o control (recibí "${PERFIL}")`);
  process.exit(2);
}
if (BASE !== null && !/^t_[0-9a-f]{32}$/.test(BASE)) {
  console.error(`--base espera t_ y 32 hex en minúscula (recibí "${BASE}")`);
  process.exit(2);
}

const cadena = process.env.DATABASE_URL_APP?.trim();
if (!cadena) {
  console.error("Falta DATABASE_URL_APP.");
  process.exit(2);
}
const url = BASE === null ? cadena : cadenaConBase(cadena, BASE);

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
if (PERFIL !== "unico") console.log(`perfil ${PERFIL}${BASE === null ? "" : ` · base ${BASE}`}`);
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
 * Qué privilegios tiene el rol sobre una tabla.
 *
 * `has_table_privilege` y no `information_schema.table_privileges`: la vista
 * lista sólo lo concedido directamente, y se pierde lo que llega por herencia
 * de otro rol. Ahí un permiso que existe aparece como faltante, y se termina
 * concediendo de nuevo algo que ya estaba.
 *
 * `quote_ident` porque `user` es palabra reservada.
 */
async function privilegiosDe(tabla: string) {
  const [p] = (await sql`
    select
      has_table_privilege(${rol}, 'public.' || quote_ident(${tabla}), 'SELECT') as leer,
      has_table_privilege(${rol}, 'public.' || quote_ident(${tabla}), 'INSERT') as insertar,
      has_table_privilege(${rol}, 'public.' || quote_ident(${tabla}), 'UPDATE') as actualizar,
      has_table_privilege(${rol}, 'public.' || quote_ident(${tabla}), 'DELETE') as borrar,
      (select count(*)::int from pg_policies
        where schemaname = 'public' and tablename = ${tabla}) as politicas
  `) as Array<{
    leer: boolean;
    insertar: boolean;
    actualizar: boolean;
    borrar: boolean;
    politicas: number;
  }>;
  return p;
}

const TODOS = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const ESCRITURA = ["INSERT", "UPDATE", "DELETE"];

/**
 * Lo que el rol NO tiene que tener sobre una tabla, según el perfil.
 *
 * Es `PERMISOS_QUITADOS` más lo que cada perfil quita (ver `permisos-por-perfil.mjs`):
 * el cliente pierde las tablas de control enteras y la escritura de lo espejado y
 * de `tenants`; control pierde la escritura de todo lo que no es suyo.
 */
function quitadosDe(tabla: string): readonly string[] {
  const base: readonly string[] = PERMISOS_QUITADOS[tabla as keyof typeof PERMISOS_QUITADOS] ?? [];
  if (PERFIL === "cliente") {
    if (TABLAS_SOLO_DE_CONTROL.includes(tabla)) return TODOS;
    if (ESPEJADAS_DE_SOLO_LECTURA.includes(tabla) || tabla === "tenants") return [...new Set([...base, ...ESCRITURA])];
  }
  if (PERFIL === "control" && !TABLAS_DE_CONTROL.includes(tabla)) return [...new Set([...base, ...ESCRITURA])];
  return base;
}

/** Lo quitado a propósito (`permisos-quitados.mjs`) falla al revés: por TENERLO. */
function desviosDe(tabla: string, p: Awaited<ReturnType<typeof privilegiosDe>>): string[] {
  const quitados = quitadosDe(tabla);
  const tiene = { SELECT: p.leer, INSERT: p.insertar, UPDATE: p.actualizar, DELETE: p.borrar };
  const privilegios = Object.keys(tiene) as Array<keyof typeof tiene>;
  const falta = privilegios.filter((x) => !quitados.includes(x) && !tiene[x]);
  const sobra = privilegios.filter((x) => quitados.includes(x) && tiene[x]);
  return [
    ...(falta.length ? [`${tabla}: le falta ${falta.join(", ")}`] : []),
    ...(sobra.length ? [`${tabla}: tiene ${sobra.join(", ")} y se le quitó a propósito`] : []),
  ];
}

const faltantes: string[] = [];
const sinForzar: string[] = [];
const sinPolitica: string[] = [];

for (const t of tablas) {
  const p = await privilegiosDe(t.tabla);
  faltantes.push(...desviosDe(t.tabla, p));
  if (!t.forzado) sinForzar.push(t.tabla);
  if (p.politicas === 0) sinPolitica.push(t.tabla);
}

console.log(`\n▸ ${tablas.length} tabla(s) con columna de inquilino`);

if (faltantes.length === 0) {
  const excepciones = Object.entries(PERMISOS_QUITADOS).map(([tabla, sin]) => `${tabla} sin ${sin.join(", ")}`);
  console.log(
    PERFIL === "unico"
      ? `   ✓ el rol puede leer, insertar, actualizar y borrar en todas — salvo ${excepciones.join("; ")}`
      : `   ✓ cada una con lo que dice el perfil ${PERFIL}`
  );
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

// ── Lo que trae la 0048 ─────────────────────────────────────────────────────
//
// `tenants`, `account`, `session`, `verification` y `user` no tienen columna de
// inquilino, así que el recorrido de arriba no las ve. Se miran acá, con la misma
// lista, más los permisos por columna y la función que crea inquilinos.
console.log("\n▸ Tablas sin columna de inquilino");
const sinColumna: string[] = [];
const sinInquilino = new Set([...Object.keys(PERMISOS_QUITADOS), ...(PERFIL === "cliente" ? TABLAS_SOLO_DE_CONTROL : [])]);
for (const tabla of sinInquilino) {
  if (tablas.some((t) => t.tabla === tabla)) continue;
  const [e] = (await sql`select to_regclass('public.' || quote_ident(${tabla})) is not null as existe`) as Array<{
    existe: boolean;
  }>;
  if (e.existe) sinColumna.push(...desviosDe(tabla, await privilegiosDe(tabla)));
}

// La 0048 y la 0049 se aplican a mano: sin ellas no hay funciones, ni tabla de números, ni columna.
const [m] = (await sql`
  select
    to_regprocedure('public.claimmix_crear_inquilino(uuid, uuid, text, text, integer, integer, inet)') is not null as funcion,
    to_regprocedure('public.claimmix_numero_automatico(uuid, uuid, text, text, text, text, inet)') is not null as numero,
    to_regclass('public.whatsapp_numeros') is not null as numeros,
    exists (
      select 1 from pg_attribute
      where attrelid = to_regclass('public.tenants') and attname = 'autoalta' and not attisdropped
    ) as columna
`) as Array<{ funcion: boolean; numero: boolean; numeros: boolean; columna: boolean }>;
const sinMigrar = [
  ...(m.funcion ? [] : ["la función claimmix_crear_inquilino"]),
  ...(m.numeros ? [] : ["la tabla whatsapp_numeros"]),
  ...(m.columna ? [] : ["la columna tenants.autoalta"]),
];
if (sinMigrar.length) sinColumna.push(`0048 sin aplicar en esta base: falta ${sinMigrar.join(", ")}`);
if (!m.numero) sinColumna.push("0049 sin aplicar en esta base: falta la función claimmix_numero_automatico");

// `tenants` no tiene tenant_id: su política compara la propia columna id.
const [rlsTenants] = (await sql`
  select c.relrowsecurity as rls, c.relforcerowsecurity as forzado,
         (select count(*)::int from pg_policies
           where schemaname = 'public' and tablename = 'tenants'
             and policyname = 'claimmix_tenant_isolation') as politicas
  from pg_class c
  where c.oid = to_regclass('public.tenants')
`) as Array<{ rls: boolean; forzado: boolean; politicas: number }>;
if (!rlsTenants.rls || !rlsTenants.forzado || rlsTenants.politicas === 0) {
  sinColumna.push("tenants: sin RLS forzada o sin la política claimmix_tenant_isolation");
}

// Cada columna con el permiso que le toca: ni una más, ni una menos.
for (const [tabla, porPrivilegio] of Object.entries(PERMISOS_POR_COLUMNA)) {
  for (const [privilegio, columnas] of Object.entries(porPrivilegio)) {
    // El perfil cliente le quita al rol la tabla entera: ninguna columna.
    const permitidas = PERFIL === "cliente" && TABLAS_SOLO_DE_CONTROL.includes(tabla) ? [] : columnas;
    const filas = (await sql`
      select a.attname::text as columna,
             has_column_privilege(${rol}::name, 'public.' || quote_ident(${tabla}), a.attname::text, ${privilegio}) as tiene
      from pg_attribute a
      where a.attrelid = to_regclass('public.' || quote_ident(${tabla}))
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    `) as Array<{ columna: string; tiene: boolean }>;
    const falta = permitidas.filter((c) => !filas.some((f) => f.columna === c && f.tiene));
    const sobra = filas.filter((f) => f.tiene && !permitidas.includes(f.columna)).map((f) => f.columna);
    if (falta.length) sinColumna.push(`${tabla}: le falta ${privilegio} en ${falta.join(", ")}`);
    if (sobra.length) sinColumna.push(`${tabla}: tiene ${privilegio} en ${sobra.join(", ")} y no le toca`);
  }
}

// EXECUTE para el rol y cerrada a PUBLIC (`REVOKE ... FROM PUBLIC` de la 0048 y la 0049).
const FUNCIONES_DEL_ALTA: Array<[string, string, boolean]> = [
  ["claimmix_crear_inquilino", "public.claimmix_crear_inquilino(uuid, uuid, text, text, integer, integer, inet)", m.funcion],
  ["claimmix_numero_automatico", "public.claimmix_numero_automatico(uuid, uuid, text, text, text, text, inet)", m.numero],
];
for (const [nombre, firma, existe] of FUNCIONES_DEL_ALTA) {
  if (!existe) continue;
  const [f] = (await sql`
    select coalesce(has_function_privilege(${rol}::name, p.oid, 'EXECUTE'), false) as puede,
           coalesce(p.proacl is not null and not exists (
             select 1 from aclexplode(p.proacl) x where x.grantee = 0 and x.privilege_type = 'EXECUTE'
           ), false) as cerrada
    from pg_proc p
    where p.oid = to_regprocedure(${firma})::oid
  `) as Array<{ puede: boolean; cerrada: boolean }>;
  if (!f.puede) sinColumna.push(`${nombre}: el rol no puede ejecutarla`);
  if (!f.cerrada) sinColumna.push(`${nombre}: PUBLIC puede ejecutarla`);
}

if (sinColumna.length === 0) {
  console.log("   ✓ tenants, whatsapp_numeros, account, session, verification y user con lo mismo que dice la lista");
  console.log("   ✓ permisos por columna exactos y las funciones del alta cerradas a PUBLIC");
} else {
  console.log(`   ✗ ${sinColumna.length} desvío(s):`);
  for (const d of sinColumna) console.log(`      · ${d}`);
}

const problemas = faltantes.length + sinForzar.length + sinPolitica.length + sinColumna.length;
console.log("\n" + "─".repeat(70));
if (problemas === 0) {
  console.log("✓ El rol tiene exactamente lo que la capa necesita, y ni un poco más.");
  process.exit(0);
}
console.log(`✗ ${problemas} problema(s).`);
process.exit(1);
