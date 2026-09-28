/**
 * Qué botones muestra el caso, en un solo viaje.
 *
 * La confirmación de «listo para Core» (P6) y el reenvío/reapertura del pedido
 * (P8) comparten la misma pantalla y el mismo caso, así que comparten el mismo
 * lote: P8 agrega sus propias consultas a este mismo batch en vez de abrir uno
 * nuevo.
 *
 * Nunca rechaza: un caso sin acciones visibles es mejor pantalla que una
 * pantalla que no carga.
 */

import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { enTenantVarias, type TenantContext } from "@/data/scope";
import { auditLog, users } from "@/lib/db/schema";
import { AuditEvent } from "@/lib/audit/log";
import { ultimaCorrida } from "@/server/cases/listo-confirmado";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { consultasDelReenvio, deFilasDelReenvio, decidirReenvio } from "@/server/confirmations/reenvio";
import { consultaDelUltimoMovimiento, esDevolvible } from "@/server/cases/devolver-al-agente";

export type MotivoSinReenvio =
  | "estado"
  | "sin_destinatario"
  | "ventana_cerrada"
  | "nada_pendiente"
  | "reciente"
  | "cierre_no_es_abandono";

export interface EstadoDeAcciones {
  confirmado: boolean;
  confirmadoPor: string | null;
  reabrible: boolean;
  puedeReenviar: boolean;
  motivoSinReenvio: MotivoSinReenvio | null;
  /** E24: si el último movimiento del caso fue tomarlo con «Tomar el control». */
  devolvible: boolean;
}

export const SIN_ACCIONES: EstadoDeAcciones = {
  confirmado: false,
  confirmadoPor: null,
  reabrible: false,
  puedeReenviar: false,
  motivoSinReenvio: null,
  devolvible: false,
};

export async function leerEstadoDeAcciones(
  ctx: TenantContext,
  caseId: string
): Promise<EstadoDeAcciones> {
  try {
    const filas = await enTenantVarias<readonly unknown[]>(ctx, (db) => [
      db
        .select({ quien: users.full_name })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actor_id))
        .where(
          and(
            eq(auditLog.target_type, "case"),
            eq(auditLog.target_id, caseId),
            eq(auditLog.event_type, AuditEvent.CASE_READY_CONFIRMED),
            gt(auditLog.created_at, ultimaCorrida(caseId))
          )
        )
        .orderBy(desc(auditLog.created_at))
        .limit(1),
      ...consultasDelReenvio(db, caseId),
      consultaDelUltimoMovimiento(db, caseId),
    ]);

    const confirmaciones = filas[0] as Array<{ quien: string | null }>;
    const fila = confirmaciones[0];

    // `deFilasDelReenvio` sigue leyendo sus 8 filas de siempre; ignora la 9ª.
    const d = deFilasDelReenvio(filas.slice(1));
    const reabrible = d.caso?.status === "cerrado" && d.ultimoCierre === AuditEvent.CASE_CLOSED_ABANDONED;
    const dec = decidirReenvio(d, new Date(), reabrible);
    const ultimoMovimiento = (filas[9] as Array<{ event_type: string; payload: unknown }>)[0];

    return {
      confirmado: fila !== undefined,
      confirmadoPor: fila?.quien ?? null,
      reabrible,
      puedeReenviar: dec.ok,
      motivoSinReenvio: dec.ok ? null : dec.motivo,
      devolvible: esDevolvible(ultimoMovimiento),
    };
  } catch (err) {
    logger.error({ code: errorCode(err) }, "acciones.no_se_leyeron");
    return SIN_ACCIONES;
  }
}
