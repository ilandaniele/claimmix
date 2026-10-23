/**
 * Crear, migrar y dar permisos a la base de un inquilino.
 *
 * Son los pasos que corre el workflow que prepara el espacio (y el reintento de
 * los barridos). Todo va con SQL crudo y con el rol dueño: la app no puede crear
 * bases ni tocar `tenant_bases`. El registro de cada base vive en control (`db`);
 * lo que se hace adentro de la base del cliente va por un Pool de WebSocket,
 * porque necesita varias sentencias en una sola ida.
 *
 * Cada paso se puede repetir sin romper nada: el workflow los reintenta. Lo único
 * que evita que dos corran a la vez sobre la misma base es el lease de `tomarBase`.
 */

import "server-only";

import { createHash } from "node:crypto";

import { Pool, type PoolClient } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";

import { cadenaConBase } from "@/data/bases";
import { db } from "@/lib/db";
import { filasDe } from "@/lib/db/filas";
import { codigoPg } from "@/server/core-sync/config";

import { MIGRACIONES, PERMISOS_APP, PERMISOS_CLIENTE, type Migracion } from "./plantilla.generated";

const NOMBRE_DE_BASE = /^t_[0-9a-f]{32}$/;
const MAX_ERROR = 500;

// La misma forma que arma migrate.mjs: la cadena empaquetada deja el registro como si la hubiera corrido él.
const REGISTRO_DE_MIGRACIONES = `
  create table if not exists schema_migrations (
    version     text primary key,
    filename    text        not null,
    checksum    text        not null,
    applied_at  timestamptz not null default now(),
    applied_by  text
  )
`;

/** El nombre termina en un `CREATE DATABASE` y en una cadena de conexión: se comprueba antes de armar nada. */
function comprobar(base: string): string {
  if (typeof base !== "string" || !NOMBRE_DE_BASE.test(base)) {
    throw new Error("[bases] el nombre de la base no es t_ y 32 hex: no se arma el SQL.");
  }
  return base;
}

function cadenaDelDueno(): string {
  const cadena = process.env.DATABASE_URL?.trim();
  if (!cadena) throw new Error("DATABASE_URL is not set");
  return cadena;
}

/** Un Pool vive lo que dura una llamada: se conecta, se usa y se cierra, también si falla. */
async function conPool<T>(cadena: string, usar: (cx: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: cadena });
  try {
    const cx = await pool.connect();
    try {
      return await usar(cx);
    } finally {
      cx.release();
    }
  } finally {
    await pool.end();
  }
}

const literal = (texto: string) => `'${texto.replaceAll("'", "''")}'`;

/** El asiento de una migración, con el hash que usa migrate.mjs (el SQL ya viene con LF). */
function asiento(m: Migracion): string {
  const checksum = createHash("sha256").update(m.sql).digest("hex");
  return (
    "insert into schema_migrations (version, filename, checksum, applied_by) values (" +
    `${literal(m.nombre.slice(0, 4))}, ${literal(m.nombre)}, ${literal(checksum)}, 'preparar-base')`
  );
}

/** Deja la fila del inquilino en `creando`. Si ya hay una, no la toca. */
export async function registrarBase(tenantId: string): Promise<void> {
  // sin-inquilino: tenant_bases es de control y sólo la lee el rol dueño; la fila es del inquilino que se está dando de alta.
  await db.execute(sql`
    insert into public.tenant_bases (tenant_id, estado)
    values (${tenantId}::uuid, 'creando')
    on conflict do nothing
  `);
}

/**
 * Toma la base para prepararla, con un lease de `minutos`.
 *
 * Una sola sentencia: inserta la fila si falta, o la reclama si está `creando` o
 * `fallida` y nadie la tiene (o el lease venció). Devuelve null si otro workflow
 * la tiene, o si ya está `lista` o `borrada`.
 */
export async function tomarBase(tenantId: string, minutos: number): Promise<{ intentos: number } | null> {
  // sin-inquilino: lease sobre tenant_bases, tabla de control del rol dueño.
  const filas = await db.execute(sql`
    insert into public.tenant_bases as b (tenant_id, estado, intentos, tomada_at)
    values (${tenantId}::uuid, 'creando', 1, now())
    on conflict (tenant_id) do update
      set tomada_at = now(), intentos = b.intentos + 1, estado = 'creando'
      where b.estado in ('creando', 'fallida')
        and (b.tomada_at is null or b.tomada_at < now() - make_interval(mins => ${minutos}::int))
    returning b.intentos
  `);
  const fila = filasDe<{ intentos?: number | string }>(filas)[0];
  return fila ? { intentos: Number(fila.intentos) } : null;
}

/**
 * Crea la base si no está. `CREATE DATABASE` no corre dentro de una transacción:
 * el driver HTTP a veces la envuelve en una (25001), y ahí se repite por
 * WebSocket, donde la sentencia va suelta.
 */
export async function crearBaseSiFalta(base: string): Promise<"creada" | "existia"> {
  const sentencia = `CREATE DATABASE "${comprobar(base)}"`;
  try {
    // sin-inquilino: crea una base del clúster; no toca ninguna tabla.
    await db.execute(sql.raw(sentencia));
    return "creada";
  } catch (e) {
    const codigo = codigoPg(e);
    if (codigo === "42P04") return "existia";
    if (codigo !== "25001") throw e;
  }

  try {
    await conPool(cadenaDelDueno(), (cx) => cx.query(sentencia));
    return "creada";
  } catch (e) {
    if (codigoPg(e) === "42P04") return "existia";
    throw e;
  }
}

/**
 * Aplica a la base las migraciones empaquetadas que le faltan, y devuelve la
 * versión en la que queda.
 *
 * Cada una va en una sola consulta simple junto con su asiento en
 * `schema_migrations`: Postgres corre las consultas con varias sentencias como una
 * sola transacción, así que una migración y su asiento entran las dos o ninguna.
 * Pensada para una base nueva y vacía; las que ya existen se migran a mano.
 */
export async function migrarBase(base: string): Promise<number> {
  const cadena = cadenaConBase(cadenaDelDueno(), comprobar(base));
  return conPool(cadena, async (cx) => {
    await cx.query(REGISTRO_DE_MIGRACIONES);
    const { rows } = await cx.query("select coalesce(max(version::int), 0)::int as v from schema_migrations");
    let version = Number(rows[0]?.v ?? 0);
    for (const m of MIGRACIONES) {
      if (m.version <= version) continue;
      await cx.query(`${m.sql}\n;\n${asiento(m)}`);
      version = m.version;
    }
    return version;
  });
}

/** Los permisos de la app en la base, y después los que se le quitan en la de un cliente. En una sola consulta, o entran todos o ninguno. */
export async function darPermisos(base: string): Promise<void> {
  const cadena = cadenaConBase(cadenaDelDueno(), comprobar(base));
  await conPool(cadena, (cx) => cx.query([...PERMISOS_APP, ...PERMISOS_CLIENTE].join(";\n")));
}

/**
 * Cierra el intento: la base queda `lista` o `fallida`. En los dos casos se suelta
 * el lease, porque el workflow ya terminó y el reintento no tiene que esperar.
 *
 * Sólo toca una fila `creando` o `fallida`: un workflow vencido, cuyo lease ya
 * retomó otro, no baja a `fallida` la base que el otro dejó `lista`, ni revive una `borrada`.
 */
export async function marcarBase(
  tenantId: string,
  estado: "lista" | "fallida",
  datos: { version?: number; error?: string },
): Promise<void> {
  // sin-inquilino: tenant_bases es de control y sólo la lee el rol dueño.
  await db.execute(sql`
    update public.tenant_bases set
      estado = ${estado}::text,
      version_migracion = coalesce(${datos.version ?? null}::int, version_migracion),
      ultimo_error = ${datos.error?.slice(0, MAX_ERROR) ?? null}::text,
      lista_at = case when ${estado === "lista"}::boolean then now() else lista_at end,
      tomada_at = null
    where tenant_id = ${tenantId}::uuid and estado in ('creando', 'fallida')
  `);
}

/**
 * Cuántas bases de cliente hay y cuánto pesa el proyecto entero, en MB.
 *
 * El peso suma todas las bases a las que el rol puede conectarse (la de control
 * incluida), que es lo que cuenta contra el tope del plan; `pg_database_size`
 * falla en las que no puede abrir, por eso el filtro de CONNECT.
 */
export async function topesDeBases(): Promise<{ bases: number; mb: number }> {
  // sin-inquilino: catálogo del clúster, no una tabla de inquilino.
  const filas = await db.execute(sql`
    select
      count(*) filter (where datname ~ '^t_[0-9a-f]{32}$')::int as bases,
      coalesce(round(sum(pg_database_size(oid)) / 1048576.0), 0)::int as mb
    from pg_database
    where not datistemplate and has_database_privilege(oid, 'CONNECT')
  `);
  const fila = filasDe<{ bases?: number | string; mb?: number | string }>(filas)[0];
  return { bases: Number(fila?.bases ?? 0), mb: Number(fila?.mb ?? 0) };
}
