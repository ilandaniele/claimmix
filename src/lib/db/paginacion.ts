/**
 * Una página de resultados: el total y las filas, en un solo viaje a la base.
 *
 * Listar algo paginado son siempre dos consultas —cuántas hay y cuáles caen en
 * esta página— y estaban escritas como dos `await` seguidos. Con el driver HTTP
 * de Neon eso es literalmente dos POST: dos handshakes, dos latencias de red y,
 * peor, dos instantáneas distintas de la tabla. Entre una y otra puede entrar
 * una fila, y la respuesta sale diciendo «total: 40» sobre una página calculada
 * contra 41.
 *
 * `enTenantVarias` las manda en un `batch()`, que es UNA transacción: el conteo
 * y las filas ven lo mismo, y se paga una sola ida y vuelta.
 */

import "server-only";

import { sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { enTenantVarias, type ClienteDatos, type TenantContext } from "@/data/scope";

export interface Pagina<T> {
  data: T[];
  meta: { total: number; page: number; per_page: number; pages: number };
}

/**
 * Cuenta y trae una página, con el mismo `where` para las dos consultas.
 *
 * @param tabla sobre la que se cuenta. Si la consulta de datos hace un
 *   `leftJoin`, el conteo va igual sobre la tabla base: un left join no cambia
 *   la cantidad de filas de la izquierda, y contarlo con el join adentro sería
 *   pagar el join para nada.
 * @param datos arma la consulta de la página —con su `limit` y su `offset`—.
 *   Recibe el mismo handle que el conteo, así las dos van en el mismo lote.
 */
export async function paginarEnTenant<T>(
  ctx: TenantContext,
  opciones: { tabla: PgTable; where?: SQL; page: number; per_page: number },
  datos: (db: ClienteDatos) => unknown
): Promise<Pagina<T>> {
  const { tabla, where, page, per_page } = opciones;

  const [conteo, filas] = await enTenantVarias<[Array<{ n: number }>, T[]]>(
    ctx,
    (db) => [
      db.select({ n: sql<number>`count(*)::int` }).from(tabla).where(where),
      datos(db),
    ]
  );

  const total = conteo[0]?.n ?? 0;
  return {
    data: filas,
    meta: { total, page, per_page, pages: Math.ceil(total / per_page) },
  };
}
