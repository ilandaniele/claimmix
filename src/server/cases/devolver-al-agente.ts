/**
 * «Devolver al agente» (E24): si el último movimiento de un caso fue tomarlo
 * con «Tomar el control», una persona con plan Pro puede devolvérselo al
 * agente. Sólo eso: el PATCH que lo mueve vive en `patch.ts`, y la guarda de
 * qué se puede devolver está acá porque la usan tanto el botón (`page.tsx`,
 * vía `puedeDevolverAlAgente`) como el PATCH.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { ClienteDatos } from "@/data/scope";
import { auditLog } from "@/lib/db/schema";
import { AuditEvent } from "@/lib/audit/log";

export const MOTIVO_DEVOLVER = "devolver_al_agente" as const;
export const MOTIVO_TOMAR = "tomar_el_control" as const;

/**
 * Eventos que mueven el estado del caso; el más nuevo dice quién lo movió
 * por última vez. `case.re_analyze_triggered` no cambia el estado en sí,
 * pero sí lo devuelve a `procesando`, así que también cuenta como «alguien
 * más tocó el caso después de tomarlo».
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
  AuditEvent.AI_EXTRACTED,
  AuditEvent.AI_BUDGET_EXCEEDED,
  AuditEvent.CORE_SYNC_SUCCESS,
  AuditEvent.CORE_SYNC_FAILED,
  "case.re_analyze_triggered",
];

export type UltimoMovimiento = { event_type: string; payload: unknown } | null | undefined;

/**
 * Query builder, sin resolver: se mete en el batch de `leerEstadoDeAcciones`
 * (para el botón) y en el de `patchCase` (para la guarda de verdad).
 */
export function consultaDelUltimoMovimiento(db: ClienteDatos, caseId: string) {
  return db
    .select({ event_type: auditLog.event_type, payload: auditLog.payload })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.target_type, "case"),
        eq(auditLog.target_id, caseId),
        inArray(auditLog.event_type, MOVIMIENTOS_DEL_CASO)
      )
    )
    .orderBy(desc(auditLog.created_at))
    .limit(1);
}

/** El caso se devuelve si lo último que le pasó fue que alguien lo tomó. */
export function esDevolvible(ultimo: UltimoMovimiento): boolean {
  if (!ultimo || ultimo.event_type !== AuditEvent.CASE_STATUS_CHANGED) return false;
  const payload = ultimo.payload as { reason?: unknown; new_status?: unknown } | null;
  return payload?.reason === MOTIVO_TOMAR && payload?.new_status === "requiere_especialista";
}
