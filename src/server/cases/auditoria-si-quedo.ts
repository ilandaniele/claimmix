/**
 * Un `audit_log` guardado sólo si el UPDATE que lo acompaña pegó.
 *
 * La confirmación de «listo para Core» (P6) y la reapertura por abandono (P8)
 * comparten el mismo problema: el batch HTTP de Neon es una sola transacción,
 * pero un UPDATE con guarda que no matchea ninguna fila no es un error — es un
 * SELECT con cero filas. Sin esto, esa auditoría se escribía igual, y quedaba
 * un `case.ready_confirmed` sobre un estado que en realidad no cambió.
 *
 * El INSERT ... SELECT mira si la fila quedó en `estado` y la tocó esta misma
 * transacción: si el SELECT no devuelve fila, el INSERT no inserta nada, y no
 * hace falta ningún chequeo aparte.
 *
 * «La tocó esta transacción» es `updated_at = now()`, no la hora que puso el
 * código: `trg_cases_updated_at` la pisa con `now()`, que es el comienzo de la
 * transacción. Comparar contra la hora del código no matcheaba nunca, y ni la
 * confirmación de listo ni la reapertura ni la devolución quedaban auditadas.
 *
 * Drizzle exige que el SELECT traiga cada columna de la tabla, en su orden,
 * `id` y `created_at` incluidos; si falta una, tira antes de mandar nada.
 */

import "server-only";
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { auditLog, cases } from "@/lib/db/schema";
import type { ClienteDatos } from "@/data/scope";
import { ipValida, type AuditEventType } from "@/lib/audit/log";
import type { CaseStatus } from "@/lib/schemas/cases";

type FilaDeAuditoria = {
  caseId: string;
  actorId: string | null;
  eventType: AuditEventType;
  ip?: string | null;
  ua?: string | null;
};

/** El INSERT ... SELECT desde la fila del caso, con el `where` y el payload que decide cada guarda. */
function auditoriaDesdeElCaso(
  db: ClienteDatos,
  a: FilaDeAuditoria,
  payload: SQL<Record<string, unknown>>,
  donde: SQL | undefined
) {
  // `getClientIp` puede devolver "anonymous", que no es un `inet` válido y
  // tiraría abajo todo el batch.
  const ip = ipValida(a.ip);

  return db.insert(auditLog).select(
    db
      .select({
        id: sql<number>`nextval(pg_get_serial_sequence('public.audit_log', 'id'))`.as("id"),
        tenant_id: cases.tenant_id,
        actor_id: sql<string | null>`${a.actorId}::uuid`.as("actor_id"),
        event_type: sql<string>`${a.eventType}::text`.as("event_type"),
        target_type: sql<string>`'case'::text`.as("target_type"),
        target_id: sql<string>`${a.caseId}::text`.as("target_id"),
        payload: payload.as("payload"),
        ip: sql<string | null>`${ip}::inet`.as("ip"),
        ua: sql<string | null>`${a.ua ?? null}::text`.as("ua"),
        created_at: sql<string>`now()`.as("created_at"),
      })
      .from(cases)
      .where(donde)
  );
}

export function auditoriaSiQuedo(
  db: ClienteDatos,
  a: FilaDeAuditoria & { payload: Record<string, unknown> },
  estado: CaseStatus
) {
  return auditoriaDesdeElCaso(
    db,
    a,
    sql`${JSON.stringify(a.payload)}::jsonb`,
    and(eq(cases.id, a.caseId), eq(cases.status, estado), sql`${cases.updated_at} = now()`)
  );
}

/**
 * Un `audit_log` de cambio de estado guardado sólo si el estado de verdad va
 * a cambiar. Va ANTES del UPDATE en el lote: lee el estado de antes, que es
 * el `from` que anota, y el UPDATE de después lo pisa.
 *
 * El agente vuelve a escribir el estado que el caso ya tiene cada vez que le
 * llega un mensaje (`info_faltante` sobre `info_faltante`): eso no es un
 * cambio y no deja fila, o el trayecto del caso se llenaría de tramos vacíos
 * que le rompen la cuenta de cuánto estuvo en cada estado.
 *
 * `desde` son los estados que el UPDATE deja pisar: la misma guarda, para no
 * anotar un cambio que el UPDATE va a rechazar. Las dos sentencias van en el
 * mismo lote —una transacción—, así que sólo otra escritura simultánea, en los
 * milisegundos entre una y otra, las desacoplaría.
 */
export function auditoriaSiCambia(
  db: ClienteDatos,
  a: FilaDeAuditoria & { payload: Record<string, unknown>; desde: readonly CaseStatus[] },
  hacia: CaseStatus
) {
  return auditoriaDesdeElCaso(
    db,
    a,
    sql`${JSON.stringify(a.payload)}::jsonb || jsonb_build_object('from', ${cases.status}::text, 'old_status', ${cases.status}::text, 'to', ${hacia}::text, 'new_status', ${hacia}::text)`,
    and(eq(cases.id, a.caseId), inArray(cases.status, a.desde), ne(cases.status, hacia))
  );
}
