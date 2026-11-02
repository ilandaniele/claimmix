/**
 * ¿Qué de los casos del espacio sigue atado a esta persona? Borrar su cuenta lo
 * cambiaría sin que nadie lo pida, así que el borrado espera a que no quede nada.
 *
 * - `asignados`: el SET NULL de `cases.assigned_to` dispara `trg_cases_updated_at` y
 *   el caso reinicia los relojes que cuelgan de `updated_at` (abandono, recordatorios,
 *   el filtro de 48 h, la ventana del hilo de WhatsApp, `updated_since` de la API).
 *   Se mira en todos los casos, de cualquier estado: uno cerrado también se reinicia.
 * - `firmo`: el SET NULL de `audit_log.actor_id` deja sin autor lo que ella hizo en
 *   un caso, y `actor_id` nulo es lo que distingue al agente de una persona: la toma
 *   de «Tomar el control» (`devolver-al-agente.ts`), el ancla de las derivaciones y
 *   los desvíos y el «llegó a listo solo» del tablero la leen así. Borrarla haría
 *   pasar sus intervenciones por trabajo del agente, con cualquier evento de caso.
 *
 * El disparador y esa lectura no se pueden esquivar sin una migración; una sola
 * consulta a la base del cliente cubre las dos.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { enTenant } from "@/data/scope";
import { filasDe } from "@/lib/db/filas";
import { firstRow } from "@/lib/db/helpers";

export type CasoQueRetiene = "asignados" | "firmo";

export async function casoQueRetiene(tenantId: string, personaId: string): Promise<CasoQueRetiene | null> {
  const fila = firstRow(
    filasDe<{ asignados: boolean; firmo: boolean }>(
      await enTenant({ tenantId }, (db) =>
        db.execute(sql`
          select exists (select 1 from cases where assigned_to = ${personaId}::uuid) as asignados,
                 exists (select 1 from audit_log where actor_id = ${personaId}::uuid and target_type = 'case') as firmo
        `)
      )
    )
  );
  if (fila?.asignados) return "asignados";
  return fila?.firmo ? "firmo" : null;
}
