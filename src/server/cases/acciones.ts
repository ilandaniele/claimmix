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
import { logger } from "@/lib/observability/logger";

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
}

export const SIN_ACCIONES: EstadoDeAcciones = {
  confirmado: false,
  confirmadoPor: null,
  reabrible: false,
  puedeReenviar: false,
  motivoSinReenvio: null,
};

export async function leerEstadoDeAcciones(
  ctx: TenantContext,
  caseId: string
): Promise<EstadoDeAcciones> {
  try {
    const [confirmaciones] = await enTenantVarias<[Array<{ quien: string | null }>]>(
      ctx,
      (db) => [
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
      ]
    );

    const fila = confirmaciones[0];
    return {
      ...SIN_ACCIONES,
      confirmado: fila !== undefined,
      confirmadoPor: fila?.quien ?? null,
    };
  } catch (err) {
    const code =
      (err as { code?: string })?.code ??
      (err instanceof Error ? err.name : "UnknownError");
    logger.error({ code }, "acciones.no_se_leyeron");
    return SIN_ACCIONES;
  }
}
