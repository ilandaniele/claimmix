/**
 * Corre un barrido en cada base de cliente.
 *
 * Los barridos (trabados, abandonados, recordatorios, retención…) leen con el rol
 * dueño los casos de TODOS los inquilinos, y con `BASE_POR_CLIENTE=1` esos casos
 * viven en una base por inquilino. Este recorrido le da a cada barrido la base que
 * le toca, de a una y en serie: abrir las treinta a la vez sólo multiplicaría
 * conexiones contra un solo compute.
 *
 * Apagada la bandera hay una sola base y el barrido corre una vez, con `db` y sin
 * inquilino: exactamente lo de antes, y si tira, tira.
 *
 * Con la bandera, una base que falla se cuenta y no frena a las demás. El recorrido
 * empieza cada hora por otra base y, a la misma hora, un lugar más adelante cada
 * día: los barridos diarios (purga, retención) también rotan, aunque la cantidad de
 * bases divida a 24. Así, si `hasta` no alcanza, no quedan siempre las mismas
 * afuera; las que no entraron se informan como `pendientes` y salen en otra corrida.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { basePorCliente, nombreDeBase } from "@/data/bases";
import { db, dbDeBase, type DbDueno } from "@/lib/db";
import { filasDe } from "@/lib/db/filas";
import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";

const HORA_MS = 60 * 60_000;
const DIA_MS = 24 * HORA_MS;

/** Avanza uno por hora y, a la misma hora del día, uno por día. */
function vuelta(ahora: number): number {
  return Math.floor(ahora / DIA_MS) + (Math.floor(ahora / HORA_MS) % 24);
}

export async function paraCadaBase<T>(
  trabajo: (db: DbDueno, tenantId: string | null) => Promise<T>,
  opciones: { hasta: number },
): Promise<{ resultados: T[]; pendientes: number; fallas: number }> {
  if (!basePorCliente()) return { resultados: [await trabajo(db, null)], pendientes: 0, fallas: 0 };

  let ids: string[];
  try {
    // sin-inquilino: tenant_bases es de control y sólo la lee el rol dueño.
    const filas = await db.execute(sql`
      select tenant_id from public.tenant_bases
      where estado = 'lista'
      order by hashtext(tenant_id::text), tenant_id
    `);
    ids = filasDe<{ tenant_id: string }>(filas).map((f) => f.tenant_id);
  } catch (e) {
    logger.warn({ detalle: codigoPg(e) }, "bases.barrido_sin_lista");
    return { resultados: [], pendientes: 0, fallas: 1 };
  }

  const desde = ids.length > 0 ? vuelta(Date.now()) % ids.length : 0;
  const orden = [...ids.slice(desde), ...ids.slice(0, desde)];
  const resultados: T[] = [];
  let recorridas = 0;
  let fallas = 0;
  for (const tenantId of orden) {
    if (Date.now() >= opciones.hasta) break;
    recorridas++;
    try {
      resultados.push(await trabajo(dbDeBase(nombreDeBase(tenantId)), tenantId));
    } catch (e) {
      fallas++;
      // El mensaje del error puede llevar filas (correos incluidos): sólo el código.
      logger.warn({ tenantId, detalle: codigoPg(e) }, "bases.barrido_fallo");
    }
  }
  return { resultados, pendientes: orden.length - recorridas, fallas };
}
