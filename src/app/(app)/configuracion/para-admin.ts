import "server-only";

import { eq } from "drizzle-orm";
import type { RangosDeMonto } from "@/core/case/monto-estimado";
import { enTenantVarias } from "@/data/scope";
import { tenants } from "@/lib/db/schema";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { esFaltaDe0036, vistaDeLaConfig, type VistaDeLaConfig } from "@/server/core-sync/config";
import { listaDelTenant } from "@/server/notify/specialist-alert";
import { panelSso, type PanelSso } from "@/server/sso/panel";

export interface ParaAdmin {
  alertas: string[];
  /** Cuándo se recuerda lo que falta (B4). undefined: no se pudo leer. */
  recordatorioHoras?: number[];
  /** undefined: no se pudo leer. */
  core?: VistaDeLaConfig | null;
  /** La tabla propia de montos (B23). null: la de por defecto; undefined: no se pudo leer. */
  montos?: RangosDeMonto | null;
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
  // Avisos, horas y montos salen de la misma fila del tenant: una sola lectura.
  type Fila = { emails: string[]; horas?: number[]; montos?: RangosDeMonto | null };
  const leer = (conHoras: boolean, conMontos: boolean) =>
    enTenantVarias<[Fila[], VistaDeLaConfig[]]>({ tenantId }, (db) => [
      db
        .select({
          emails: tenants.specialist_alert_emails,
          ...(conHoras ? { horas: tenants.recordatorio_horas } : {}),
          ...(conMontos ? { montos: tenants.rangos_de_monto } : {}),
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
      vistaDeLaConfig(db),
    ]);
  try {
    // Sin la 0040 falla la columna de los montos y sin la 0039 la de las horas:
    // el resto se lee sin ellas, y el panel que falta no se muestra.
    const sinColumna = (e: unknown, otra: () => ReturnType<typeof leer>) => {
      if (!esFaltaDe0036(e)) throw e;
      return otra();
    };
    const [[fila], [core]] = await leer(true, true)
      .catch((e) => sinColumna(e, () => leer(true, false)))
      .catch((e) => sinColumna(e, () => leer(false, false)));
    return {
      alertas: fila?.emails ?? [],
      recordatorioHoras: fila ? fila.horas : [],
      montos: fila ? fila.montos : null,
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

/**
 * El SSO del admin, aparte del lote de arriba: sin la 0045 esa lectura falla, y
 * no puede llevarse puestos los montos y la entrega al core que sí se leen.
 * Nunca rechaza; `null` es que no se pudo leer y la sección no se muestra.
 */
export async function ssoParaAdmin(tenantId: string): Promise<PanelSso | null> {
  try {
    return await panelSso(tenantId);
  } catch (e) {
    logger.error({ code: errorCode(e) }, "configuracion.sso_no_se_leyo");
    return null;
  }
}
