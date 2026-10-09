/**
 * Vuelve a lanzar la preparación de las bases que quedaron a medias.
 *
 * `tenant_bases` no entra en la misma transacción que el alta del inquilino, así
 * que hay tres maneras de quedar sin base lista: sin fila (el alta cayó antes de
 * registrarla), `fallida` (con intentos por gastar) y `creando` con el lease
 * vencido (el flujo murió a mitad de camino). Un `LEFT JOIN` desde `tenants` las
 * encuentra a las tres. Lo que corre es `iniciarBase`, el mismo camino que el
 * botón «Reintentar»; si otro flujo ya tiene la base, el lease de `tomarBase` lo
 * frena.
 *
 * Nunca tira: es la red de debajo del alta, y un fallo acá no puede tirar el cron.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { basePorCliente } from "@/data/bases";
import { db } from "@/lib/db";
import { filasDe } from "@/lib/db/filas";
import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";

import { MINUTOS_PARA_REINTENTAR } from "./espera";
import { iniciarBase } from "./iniciar";

/** A los cinco fallos la base deja de reintentarse sola: queda para que alguien la mire. */
const INTENTOS_MAXIMOS = 5;

/** Cuántas por corrida: cada una es un flujo nuevo, y lo que hoy no entra entra en la próxima. */
const POR_CORRIDA = 20;

export async function reintentarBases(hasta: number): Promise<{ lanzadas: number }> {
  if (!basePorCliente()) return { lanzadas: 0 };

  let ids: string[];
  try {
    // sin-inquilino: tenants y tenant_bases son de control y las lee el rol dueño; el barrido mira a todos los inquilinos.
    const filas = await db.execute(sql`
      select t.id as tenant_id
      from public.tenants t
      left join public.tenant_bases b on b.tenant_id = t.id
      where b.tenant_id is null
         or (b.estado = 'fallida' and b.intentos < ${INTENTOS_MAXIMOS}::int)
         or (b.estado = 'creando'
             and coalesce(b.tomada_at, b.creada_at) < now() - make_interval(mins => ${MINUTOS_PARA_REINTENTAR}::int))
      order by t.created_at, t.id
      limit ${POR_CORRIDA}::int
    `);
    ids = filasDe<{ tenant_id: string }>(filas).map((f) => f.tenant_id);
  } catch (e) {
    logger.warn({ detalle: codigoPg(e) }, "bases.reintento_sin_lista");
    return { lanzadas: 0 };
  }

  let lanzadas = 0;
  for (const tenantId of ids) {
    if (Date.now() >= hasta) break;
    try {
      await iniciarBase(tenantId);
      lanzadas++;
    } catch (e) {
      logger.warn({ tenantId, detalle: codigoPg(e) }, "bases.reintento_fallo");
    }
  }
  return { lanzadas };
}
