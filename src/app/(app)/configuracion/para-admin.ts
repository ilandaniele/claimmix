import "server-only";

import { eq } from "drizzle-orm";
import { enTenantVarias } from "@/data/scope";
import { tenants } from "@/lib/db/schema";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { esFaltaDe0036, vistaDeLaConfig, type VistaDeLaConfig } from "@/server/core-sync/config";
import { listaDelTenant } from "@/server/notify/specialist-alert";

export interface ParaAdmin {
  alertas: string[];
  /** Cuándo se recuerda lo que falta (B4). undefined: no se pudo leer. */
  recordatorioHoras?: number[];
  /** undefined: no se pudo leer. */
  core?: VistaDeLaConfig | null;
  migracionPendiente: boolean;
}

/**
 * Lo que ve un admin: avisos, recordatorios y entrega al core, en un solo lote.
 *
 * Nunca rechaza, como `listaDelTenant` antes de B5: un error de la base no
 * tumba /configuracion entera. Sin poder leer la config, la sección del core
 * no se muestra: en blanco invitaría a generar un secreto encima del que hay.
 */
export async function paraAdmin(tenantId: string): Promise<ParaAdmin> {
  // Avisos y horas salen de la misma fila del tenant: una sola lectura.
  const leer = (conHoras: boolean) =>
    enTenantVarias<[Array<{ emails: string[]; horas?: number[] }>, VistaDeLaConfig[]]>({ tenantId }, (db) => [
      db
        .select({
          emails: tenants.specialist_alert_emails,
          ...(conHoras ? { horas: tenants.recordatorio_horas } : {}),
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
      vistaDeLaConfig(db),
    ]);
  try {
    // Sin la 0039 falla sólo la columna de las horas: el resto se lee sin ella,
    // y sin horas el panel de recordatorios no se muestra.
    const [[fila], [core]] = await leer(true).catch((e) => {
      if (!esFaltaDe0036(e)) throw e;
      return leer(false);
    });
    return {
      alertas: fila?.emails ?? [],
      recordatorioHoras: fila ? fila.horas : [],
      core: core ?? null,
      migracionPendiente: false,
    };
  } catch (e) {
    // La 0036 se aplica a mano: sin la tabla, el lote entero falla y la lista va sola.
    if (esFaltaDe0036(e)) return { alertas: await listaDelTenant(tenantId), core: null, migracionPendiente: true };
    logger.error({ code: errorCode(e) }, "configuracion.admin_no_se_leyo");
    return { alertas: await listaDelTenant(tenantId), migracionPendiente: false };
  }
}
