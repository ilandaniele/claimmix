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
    const [presupuesto, filas] = await Promise.all([
      modoDeIa() === "mock" ? null : checkBudget(ctx.tenantId, null, { llamadas: 0 }),
      enTenant(ctx, (db) =>
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(cases)
          .where(inArray(cases.status, [...ESTADOS_DE_LA_OPCION.procesando]))
      ),
    ]);

    const estado: EstadoDelAgente["estado"] = !presupuesto
      ? "modo_prueba"
      : presupuesto.exceeded
        ? "sin_presupuesto"
        : "activo";

    return { estado, procesando: firstRow(filas)?.n ?? 0 };
  } catch {
    return null;
  }
}
