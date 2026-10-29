/**
 * Qué de los primeros pasos del alta ya está hecho: el WhatsApp conectado y una
 * casilla de Gmail. Lo usan /preparando, para decidir adónde sigue quien termina
 * de esperar, y /configuracion, para saber si todavía hay «Primeros pasos» que mostrar.
 *
 * Se lee en control, en una sola consulta: con una base por cliente la copia del
 * espacio puede no existir todavía, y el número y las casillas viven ahí.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { enControl } from "@/data/scope";
import { filasDe } from "@/lib/db/filas";
import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";

import type { ResultadoDelNumero } from "./numero-resultados";

export interface PasosHechos {
  whatsapp: boolean;
  gmail: boolean;
}

/**
 * Nunca tira: si control no contesta, o falta una tabla, no se puede afirmar que algo
 * esté hecho y los dos pasos cuentan como pendientes. Equivocarse hacia ahí sólo muestra de más.
 */
export async function pasosHechos(tenantId: string): Promise<PasosHechos> {
  try {
    const filas = await enControl({ tenantId }, (db) =>
      db.execute(sql`
        select
          exists (select 1 from public.whatsapp_numeros where estado = 'conectado') as whatsapp,
          exists (select 1 from public.gmail_accounts) as gmail
      `)
    );
    const fila = filasDe<{ whatsapp?: unknown; gmail?: unknown }>(filas)[0];
    return { whatsapp: fila?.whatsapp === true, gmail: fila?.gmail === true };
  } catch (e) {
    logger.warn({ error: e instanceof Error ? e.name : "UnknownError", codigo: codigoPg(e) }, "alta.pasos_hechos_fallo");
    return { whatsapp: false, gmail: false };
  }
}

export const PRIMEROS_PASOS = "/configuracion?primeros=1";

/**
 * Adónde sigue quien termina de esperar su base. A la bandeja sólo con las dos cosas
 * hechas, y es un chequeo positivo: cualquier otro caso, incluido no tener ni fila,
 * va a los primeros pasos. `wa` es el resultado del número que venía en la dirección
 * (ya validado contra la lista cerrada) y se conserva para que /configuracion lo diga.
 */
export function destinoAlTerminarLaBase({ whatsapp, gmail }: PasosHechos, wa: ResultadoDelNumero | null): string {
  if (whatsapp && gmail) return "/bandeja";
  return `${PRIMEROS_PASOS}${wa ? `&wa=${wa}` : ""}`;
}
