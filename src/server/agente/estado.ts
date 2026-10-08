/**
 * El estado del agente para el indicador del sidebar (G37).
 *
 * Nunca tira: un error acá no puede voltear el layout entero, así que
 * cualquier falla —de la base o de un chequeo de presupuesto— devuelve null,
 * y el componente que lo llama no dibuja nada.
 */

import "server-only";
import { inArray, sql } from "drizzle-orm";
import { ESTADOS_DE_LA_OPCION } from "@/core/case/filtro-de-estado";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";
import { checkBudget } from "@/server/ai/budget";
import { modoDeIa } from "@/server/ai/provider";

export interface EstadoDelAgente {
  estado: "activo" | "modo_prueba" | "sin_presupuesto";
  procesando: number;
}

/**
 * `llamadas: 0`: el indicador se dibuja en cada pantalla y mirar no es llamar al
 * modelo. Si reservara, cada render de una prueba le gastaría el cupo diario.
 */
export async function leerEstadoDelAgente(
  ctx: TenantContext
): Promise<EstadoDelAgente | null> {
  try {
    const estado: EstadoDelAgente["estado"] =
      modoDeIa() === "mock"
        ? "modo_prueba"
        : (await checkBudget(ctx.tenantId, null, { llamadas: 0 })).exceeded
          ? "sin_presupuesto"
          : "activo";

    const row = firstRow(
      await enTenant(ctx, (db) =>
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(cases)
          .where(inArray(cases.status, [...ESTADOS_DE_LA_OPCION.procesando]))
      )
    );

    return { estado, procesando: row?.n ?? 0 };
  } catch {
    return null;
  }
}
