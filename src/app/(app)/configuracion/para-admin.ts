import "server-only";

import { enTenantVarias } from "@/data/scope";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { esFaltaDe0036, vistaDeLaConfig, type VistaDeLaConfig } from "@/server/core-sync/config";
import { consultaDeLaLista, listaDelTenant } from "@/server/notify/specialist-alert";

export interface ParaAdmin {
  alertas: string[];
  /** undefined: no se pudo leer. */
  core?: VistaDeLaConfig | null;
  migracionPendiente: boolean;
}

/**
 * Lo que ve un admin: avisos y entrega al core, en un solo lote.
 *
 * Nunca rechaza, como `listaDelTenant` antes de B5: un error de la base no
 * tumba /configuracion entera. Sin poder leer la config, la sección del core
 * no se muestra: en blanco invitaría a generar un secreto encima del que hay.
 */
export async function paraAdmin(tenantId: string): Promise<ParaAdmin> {
  try {
    const [lista, core] = await enTenantVarias<[Array<{ emails: string[] }>, VistaDeLaConfig[]]>(
      { tenantId },
      (db) => [consultaDeLaLista(db, tenantId), vistaDeLaConfig(db)]
    );
    return { alertas: lista[0]?.emails ?? [], core: core[0] ?? null, migracionPendiente: false };
  } catch (e) {
    // La 0036 se aplica a mano: sin la tabla, el lote entero falla y la lista va sola.
    if (esFaltaDe0036(e)) return { alertas: await listaDelTenant(tenantId), core: null, migracionPendiente: true };
    logger.error({ code: errorCode(e) }, "configuracion.admin_no_se_leyo");
    return { alertas: await listaDelTenant(tenantId), migracionPendiente: false };
  }
}
