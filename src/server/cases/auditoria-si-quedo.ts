/**
 * Un `audit_log` guardado sólo si el UPDATE que lo acompaña pegó.
 *
 * La confirmación de «listo para Core» (P6) y la reapertura por abandono (P8)
 * comparten el mismo problema: el batch HTTP de Neon es una sola transacción,
 * pero un UPDATE con guarda que no matchea ninguna fila no es un error — es un
 * SELECT con cero filas. Sin esto, esa auditoría se escribía igual, y quedaba
 * un `case.ready_confirmed` sobre un estado que en realidad no cambió.
 *
 * El INSERT ... SELECT lleva la misma guarda: si el SELECT no devuelve fila,
 * el INSERT no inserta nada, y no hace falta ningún chequeo aparte.
 */

import "server-only";
import { isIP } from "node:net";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { auditLog, cases } from "@/lib/db/schema";
import type { ClienteDatos } from "@/data/scope";
import type { AuditEventType } from "@/lib/audit/log";

export function auditoriaSiQuedo(
  db: ClienteDatos,
  a: {
    caseId: string;
    actorId: string | null;
    eventType: AuditEventType;
    payload: Record<string, unknown>;
    ip?: string | null;
    ua?: string | null;
  },
  guardia: SQL
) {
  // `getClientIp` puede devolver "anonymous", que no es un `inet` válido y
  // tiraría abajo todo el batch.
  const ip = a.ip && isIP(a.ip) !== 0 ? a.ip : null;

  return db.insert(auditLog).select(
    db
      .select({
        tenant_id: cases.tenant_id,
        actor_id: sql<string | null>`${a.actorId}::uuid`.as("actor_id"),
        event_type: sql<string>`${a.eventType}::text`.as("event_type"),
        target_type: sql<string>`'case'::text`.as("target_type"),
        target_id: sql<string>`${a.caseId}::text`.as("target_id"),
        payload: sql<Record<string, unknown>>`${JSON.stringify(a.payload)}::jsonb`.as("payload"),
        ip: sql<string | null>`${ip}::inet`.as("ip"),
        ua: sql<string | null>`${a.ua ?? null}::text`.as("ua"),
      })
      .from(cases)
      .where(and(eq(cases.id, a.caseId), guardia))
  );
}
