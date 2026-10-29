/**
 * Qué de los primeros pasos del alta ya está hecho: el WhatsApp conectado, una casilla
 * de Gmail, un segundo usuario en el equipo y el formulario web activo. Lo usan
 * /preparando, para decidir adónde sigue quien termina de esperar, y /configuracion,
 * para saber si todavía hay «Primeros pasos» que mostrar.
 *
 * Se lee en control, en una sola consulta: con una base por cliente la copia del
 * espacio puede no existir todavía, y el número, las casillas, los usuarios y el
 * formulario viven ahí.
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
  equipo: boolean;
  formulario: boolean;
}

/**
 * Nunca tira: si control no contesta, o falta una tabla, no se puede afirmar que algo
 * esté hecho y los cuatro pasos cuentan como pendientes. Equivocarse hacia ahí sólo muestra de más.
 */
export async function pasosHechos(tenantId: string): Promise<PasosHechos> {
  try {
    // El alta crea sólo al owner: «equipo» es un segundo usuario activo (`offset 1`), que nace al aceptar la invitación o al entrar por SSO, no al invitar.
    const filas = await enControl({ tenantId }, (db) =>
      db.execute(sql`
        select
          exists (select 1 from public.whatsapp_numeros where estado = 'conectado') as whatsapp,
          exists (select 1 from public.gmail_accounts) as gmail,
          exists (select 1 from public.users where tenant_id = ${tenantId}::uuid and dado_de_baja_en is null offset 1) as equipo,
          exists (select 1 from public.formulario_web where activo) as formulario
      `)
    );
    const fila = filasDe<{ whatsapp?: unknown; gmail?: unknown; equipo?: unknown; formulario?: unknown }>(filas)[0];
    return {
      whatsapp: fila?.whatsapp === true,
      gmail: fila?.gmail === true,
      equipo: fila?.equipo === true,
      formulario: fila?.formulario === true,
    };
  } catch (e) {
    logger.warn({ error: e instanceof Error ? e.name : "UnknownError", codigo: codigoPg(e) }, "alta.pasos_hechos_fallo");
    return { whatsapp: false, gmail: false, equipo: false, formulario: false };
  }
}

export const PRIMEROS_PASOS = "/configuracion?primeros=1";

/**
 * Adónde sigue quien termina de esperar su base. A la bandeja sólo con el WhatsApp y Gmail
 * hechos (el equipo y el formulario no cambian el destino), y es un chequeo positivo:
 * cualquier otro caso, incluido no tener ni fila, va a los primeros pasos. `wa` es el resultado del número que venía en la dirección
 * (ya validado contra la lista cerrada) y se conserva para que /configuracion lo diga.
 */
export function destinoAlTerminarLaBase(
  { whatsapp, gmail }: Pick<PasosHechos, "whatsapp" | "gmail">,
  wa: ResultadoDelNumero | null
): string {
  if (whatsapp && gmail) return "/bandeja";
  return `${PRIMEROS_PASOS}${wa ? `&wa=${wa}` : ""}`;
}
