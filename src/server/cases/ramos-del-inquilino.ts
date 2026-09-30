/**
 * Los ramos propios de una aseguradora (`tenant_claim_types`, 0044).
 *
 * Un solo cargador para quien los necesita: el prompt de la extracción, el
 * análisis de huecos y la pantalla de /agente. Sin la tabla (0044 sin aplicar)
 * o ante un error devuelve vacío: todo lo que lee esto anda con los ramos del
 * código, y un ramo propio que no se pudo leer no puede cortar una denuncia.
 */

import "server-only";
import { asc, sql } from "drizzle-orm";
import { enTenant, type ClienteDatos } from "@/data/scope";
import { tenantClaimTypes } from "@/lib/db/schema";
import { TOPE_DE_RAMOS_PROPIOS, type RamoDelInquilino } from "@/core/case/ramos";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";

/** La consulta sola, para poder mandarla en un lote. Ver `cargarLoDelPrompt` del worker. */
export function consultaRamosDelInquilino(db: ClienteDatos) {
  return db
    .select({
      clave: tenantClaimTypes.clave,
      nombre_es: tenantClaimTypes.nombre_es,
      nombre_en: tenantClaimTypes.nombre_en,
      documentos: tenantClaimTypes.documentos,
      datos: tenantClaimTypes.datos,
    })
    .from(tenantClaimTypes)
    .orderBy(asc(tenantClaimTypes.clave))
    .limit(TOPE_DE_RAMOS_PROPIOS);
}

export async function cargarRamosDelInquilino(tenantId: string): Promise<RamoDelInquilino[]> {
  try {
    return await enTenant<RamoDelInquilino[]>({ tenantId }, (db) => consultaRamosDelInquilino(db));
  } catch (err) {
    // 42P01: la migración 0044 todavía no está en esta base.
    if ((err as { code?: string })?.code !== "42P01") {
      logger.error({ code: errorCode(err) }, "ramos_del_inquilino.load_error");
    }
    return [];
  }
}

/** `text[]` con los valores como parámetros: un arreglo suelto en `sql` se expande a una tupla. */
const arregloDeTextos = (xs: readonly string[]) =>
  xs.length === 0
    ? sql<string[]>`'{}'::text[]`
    : sql<string[]>`array[${sql.join(
        xs.map((x) => sql`${x}`),
        sql`, `
      )}]::text[]`;

/**
 * Alta o cambio de un ramo propio, en UNA sentencia que también hace cumplir el
 * tope: la fila sale de un agregado sin GROUP BY (siempre una fila) filtrado con
 * HAVING, así que si el inquilino ya tiene el máximo y la clave es nueva no
 * inserta nada y el `returning` vuelve vacío. Dos altas simultáneas pueden pasar
 * el tope por una; el prompt y las lecturas cortan igual en el tope.
 *
 * El inquilino sale del contexto de `enTenant`: la política de RLS es la que
 * acota tanto el conteo como la inserción.
 */
export function consultaGuardarRamo(db: ClienteDatos, tenantId: string, ramo: RamoDelInquilino) {
  const t = tenantClaimTypes;
  return db
    .insert(t)
    .select(
      db
        .select({
          tenant_id: sql<string>`${tenantId}::uuid`.as("tenant_id"),
          clave: sql<string>`${ramo.clave}`.as("clave"),
          nombre_es: sql<string>`${ramo.nombre_es}`.as("nombre_es"),
          nombre_en: sql<string>`${ramo.nombre_en}`.as("nombre_en"),
          documentos: arregloDeTextos(ramo.documentos).as("documentos"),
          datos: arregloDeTextos(ramo.datos).as("datos"),
          created_at: sql<string>`now()`.as("created_at"),
          updated_at: sql<string>`now()`.as("updated_at"),
        })
        .from(t)
        .having(
          sql`count(*) < ${TOPE_DE_RAMOS_PROPIOS} or coalesce(bool_or(${t.clave} = ${ramo.clave}), false)`
        )
    )
    .onConflictDoUpdate({
      target: [t.tenant_id, t.clave],
      set: {
        nombre_es: sql`excluded.nombre_es`,
        nombre_en: sql`excluded.nombre_en`,
        documentos: sql`excluded.documentos`,
        datos: sql`excluded.datos`,
        updated_at: sql`now()`,
      },
    })
    .returning({ clave: t.clave });
}

export function consultaBorrarRamo(db: ClienteDatos, clave: string) {
  return db
    .delete(tenantClaimTypes)
    .where(sql`${tenantClaimTypes.clave} = ${clave}`)
    .returning({ clave: tenantClaimTypes.clave });
}
