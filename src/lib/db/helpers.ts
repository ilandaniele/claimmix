import { ilike, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { enTenant, type TenantContext } from "@/data/scope";

/** Returns the first row of a result set, or null when empty. */
export const firstRow = <T>(rows: T[]): T | null => rows[0] ?? null;

/** Escapes LIKE/ILIKE wildcard characters in user-supplied search input. */
const escapeLike = (q: string): string => q.replace(/[\\%_]/g, "\\$&");

/**
 * Case-insensitive substring match across any of the given columns:
 * `WHERE col1 ILIKE %q% OR col2 ILIKE %q% OR ...`
 */
export function ilikeAny(cols: AnyPgColumn[], q: string): SQL | undefined {
  const pattern = `%${escapeLike(q)}%`;
  return or(...cols.map((c) => ilike(c, pattern)));
}

/**
 * Cuenta filas de una tabla, del inquilino que se le pase.
 *
 * El contexto es obligatorio y no tiene default a propósito. Antes esto envolvía
 * `db.$count` a secas y el filtro lo ponía cada quien al llamar:
 * `countRows(cases, eq(cases.tenant_id, tenantId))`. Contar de más no rompe
 * nada visible —devuelve un número más grande— así que un olvido ahí no se cae
 * ni sale en los tests: sólo muestra en la bandeja de uno los casos de todos.
 *
 * Con el contexto en la firma, esa forma de llamarlo mal ya no compila.
 *
 * ── Por qué un `select count(*)` a mano y no `db.$count` ────────────────────
 *
 * Porque `$count` no devuelve una consulta: devuelve un objeto que se puede
 * esperar. Y la capa de datos manda las consultas por `batch()`, que necesita
 * armarlas —llamarles `_prepare()`— para pegarles adelante el contexto del
 * inquilino. A un thenable no se le puede.
 *
 * El resultado era `TypeError: query._prepare is not a function` en CADA
 * llamada: los contadores de las pestañas de la bandeja y el conteo de ejemplos
 * aprobados del entrenamiento, rotos en producción.
 *
 * No lo agarró nadie porque el guardia de la capa sólo rechazaba
 * `instanceof Promise`, y esto no es una promesa de verdad; y porque el e2e que
 * abre la bandeja con sesión se salteaba por falta de credenciales de
 * Playwright. Se descubrió al crearlas.
 */
export async function countRows(
  ctx: TenantContext,
  table: PgTable | SQLWrapper,
  where?: SQL
): Promise<number> {
  const filas = await enTenant<Array<{ n: number }>>(ctx, (db) =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(table as PgTable)
      .where(where)
  );
  return filas[0]?.n ?? 0;
}
