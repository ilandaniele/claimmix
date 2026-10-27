/**
 * «Devolver al agente» (E24): si el último movimiento de un caso fue tomarlo
 * con «Tomar el control», una persona con plan Pro puede devolvérselo al
 * agente. Sólo eso: el PATCH que lo mueve vive en `patch.ts`, y la guarda de
 * qué se puede devolver está acá porque la usan tanto el botón (`page.tsx`,
 * vía `puedeDevolverAlAgente`) como el PATCH.
 */

import { and, desc, eq, inArray, isNotNull, notExists, sql, type SQL } from "drizzle-orm";
import { enTenant, type ClienteDatos } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { auditLog, cases } from "@/lib/db/schema";
import { AuditEvent } from "@/lib/audit/log";

export const MOTIVO_DEVOLVER = "devolver_al_agente" as const;
export const MOTIVO_TOMAR = "tomar_el_control" as const;

/**
 * Eventos que mueven el estado del caso; el más nuevo de una persona dice
 * quién lo movió por última vez. `case.re_analyze_triggered` no cambia el
 * estado en sí, pero sí lo devuelve a `procesando`, así que también cuenta
 * como «alguien más tocó el caso después de tomarlo».
 *
 * Los del agente y los del sistema (sin `actor_id`) no cuentan: la toma se
 * puede con el agente a mitad de una corrida, y lo que esa corrida anote
 * después no le saca el caso a la persona. Por eso tampoco están `ai.extracted`
 * ni `ai.budget_exceeded`: los escribe la corrida, y llevan el `actor_id` de
 * quien la lanzó cuando la lanzó una persona.
 */
const MOVIMIENTOS_DEL_CASO = [
  AuditEvent.CASE_STATUS_CHANGED,
  AuditEvent.CASE_CLOSED,
  AuditEvent.CASE_READY_CONFIRMED,
  AuditEvent.CASE_REOPENED,
  AuditEvent.CASE_CLOSED_ABANDONED,
  AuditEvent.SPECIALIST_REQUIRED,
  AuditEvent.MISSING_INFO_REQUESTED,
  AuditEvent.CONFIRMATION_REQUESTED,
  AuditEvent.CORE_SYNC_SUCCESS,
  AuditEvent.CORE_SYNC_FAILED,
  "case.re_analyze_triggered",
];

export type UltimoMovimiento = { event_type: string; payload: unknown } | null | undefined;

/**
 * Query builder, sin resolver: se mete en el batch de `leerEstadoDeAcciones`
 * (para el botón) y en el de `patchCase` (para la guarda de verdad).
 */
export function consultaDelUltimoMovimiento(db: ClienteDatos, caseId: string | SQL) {
  return db
    .select({ event_type: auditLog.event_type, payload: auditLog.payload })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.target_type, "case"),
        eq(auditLog.target_id, caseId),
        inArray(auditLog.event_type, MOVIMIENTOS_DEL_CASO),
        isNotNull(auditLog.actor_id)
      )
    )
    .orderBy(desc(auditLog.created_at))
    .limit(1);
}

/** El caso se devuelve si lo último que una persona le hizo fue tomarlo. */
export function esDevolvible(ultimo: UltimoMovimiento): boolean {
  if (!ultimo || ultimo.event_type !== AuditEvent.CASE_STATUS_CHANGED) return false;
  const payload = ultimo.payload as { reason?: unknown; new_status?: unknown } | null;
  return payload?.reason === MOTIVO_TOMAR && payload?.new_status === "requiere_especialista";
}

/**
 * Una persona tomó el caso con «Tomar el control» y todavía lo tiene. Lo
 * miran el worker y los mensajeros antes de escribir o mandar algo, porque la
 * toma se puede con el agente a mitad de una corrida.
 */
export async function loTomoUnaPersona(caseId: string, tenantId: string): Promise<boolean> {
  return esDevolvible(firstRow(await enTenant({ tenantId }, (db) => consultaDelUltimoMovimiento(db, caseId))));
}

/** Misma regla que `esDevolvible`, dentro de una sentencia. Correlacionado con `cases.id`. */
export function noLoTomoUnaPersona(db: ClienteDatos): SQL {
  const u = consultaDelUltimoMovimiento(db, sql`${cases.id}::text`).as("u");
  return notExists(
    db.select({ uno: sql`1` }).from(u).where(
      and(
        eq(u.event_type, AuditEvent.CASE_STATUS_CHANGED),
        sql`${u.payload}->>'reason' = ${MOTIVO_TOMAR}`,
        sql`${u.payload}->>'new_status' = ${"requiere_especialista"}`
      )
    )
  );
}
