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
import { enTenantVarias, type ClienteDatos, type TenantContext } from "@/data/scope";
import { auditLog, cases, users } from "@/lib/db/schema";
import { AuditEvent } from "@/lib/audit/log";
import { ultimaCorrida } from "@/server/cases/listo-confirmado";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { consultasDelReenvio, deFilasDelReenvio, decidirConPlantilla } from "@/server/confirmations/reenvio";
import { consultaDelUltimoMovimiento, esDevolvible } from "@/server/cases/devolver-al-agente";
import { esModoMock, hayClienteDeCoreSync, type FilaDeCoreSync } from "@/server/core-sync/client";
import { consultaDeLaConfig, esFaltaDe0036 } from "@/server/core-sync/config";
import { esCasoReal } from "@/server/core-sync/lectura";

export type MotivoSinReenvio =
  | "estado"
  | "sin_destinatario"
  | "ventana_cerrada"
  | "plantilla_sin_aprobar"
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
  /** Si «Enviar al sistema central» tiene a quién mandarle (B5). */
  hayCore: boolean;
  /** Hay webhook, pero el caso es simulado o de prueba: no se manda (como /api/v1). */
  casoDePrueba: boolean;
}

export const SIN_ACCIONES: EstadoDeAcciones = {
  confirmado: false,
  confirmadoPor: null,
  reabrible: false,
  puedeReenviar: false,
  motivoSinReenvio: null,
  devolvible: false,
  hayCore: false,
  casoDePrueba: false,
};

export async function leerEstadoDeAcciones(
  ctx: TenantContext,
  caseId: string
): Promise<EstadoDeAcciones> {
  try {
    // Con el mock no se lee la config; sin la 0036 se repite el lote sin ella:
    // una migración pendiente esconde el botón, no todas las acciones.
    let conCore = !esModoMock();
    let filas: readonly unknown[];
    try {
      filas = await enTenantVarias<readonly unknown[]>(ctx, (db) => consultas(db, caseId, conCore));
    } catch (e) {
      if (!conCore || !esFaltaDe0036(e)) throw e;
      conCore = false;
      filas = await enTenantVarias<readonly unknown[]>(ctx, (db) => consultas(db, caseId, false));
    }

    const confirmaciones = filas[0] as Array<{ quien: string | null }>;
    const fila = confirmaciones[0];

    // `deFilasDelReenvio` sigue leyendo sus 8 filas de siempre; ignora las demás.
    const d = deFilasDelReenvio(filas.slice(1));
    const reabrible = d.caso?.status === "cerrado" && d.ultimoCierre === AuditEvent.CASE_CLOSED_ABANDONED;
    const dec = await decidirConPlantilla(d, new Date(), reabrible);
    const ultimoMovimiento = (filas[9] as Array<{ event_type: string; payload: unknown }>)[0];
    const conCliente = hayClienteDeCoreSync(conCore ? (filas[10] as FilaDeCoreSync[])[0] : null);
    // Con el mock (demo) no se mira: sus casos son todos simulados.
    const casoDePrueba = conCore && conCliente && (filas[11] as Array<{ real: boolean }>)[0]?.real !== true;

    return {
      confirmado: fila !== undefined,
      confirmadoPor: fila?.quien ?? null,
      reabrible,
      puedeReenviar: dec.ok,
      motivoSinReenvio: dec.ok ? null : dec.motivo,
      devolvible: esDevolvible(ultimoMovimiento),
      hayCore: conCliente && !casoDePrueba,
      casoDePrueba,
    };
  } catch (err) {
    logger.error({ code: errorCode(err) }, "acciones.no_se_leyeron");
    return SIN_ACCIONES;
  }
}

/** Los índices 0..9 no se mueven; la config de la aseguradora va en el 10 y si el caso es real, en el 11. */
function consultas(db: ClienteDatos, caseId: string, conCore: boolean) {
  return [
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
    ...(conCore
      ? [consultaDeLaConfig(db), db.select({ real: esCasoReal }).from(cases).where(eq(cases.id, caseId))]
      : []),
  ];
}
