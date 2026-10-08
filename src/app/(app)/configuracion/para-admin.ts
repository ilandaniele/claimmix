import "server-only";

import { eq, ne, sql } from "drizzle-orm";
import type { RangosDeMonto } from "@/core/case/monto-estimado";
import { enTenantVarias } from "@/data/scope";
import { pruebaVencida } from "@/lib/billing/plans";
import { tenants, whatsappNumeros } from "@/lib/db/schema";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { esFaltaDe0036, vistaDeLaConfig, type VistaDeLaConfig } from "@/server/core-sync/config";
import { listaDelTenant } from "@/server/notify/specialist-alert";
import { panelSso, type PanelSso } from "@/server/sso/panel";

/** En qué anda el número de WhatsApp. 'pedido' incluye al espacio sin fila: por neutralidad (H3) no se distinguen. */
export type EstadoDelNumero = "pedido" | "conectado" | "suspendido";

/** Lo que /configuracion cuenta de un espacio del alta automática. Es sólo para leer. */
export interface PruebaDelEspacio {
  /**
   * Días que le quedan a la prueba, para arriba; 0 si ya venció. null: no hay
   * prueba que contar (ya paga un plan, o no tiene fecha de fin).
   */
  dias: number | null;
  numero: EstadoDelNumero;
}

export interface ParaAdmin {
  alertas: string[];
  /** Cuándo se recuerda lo que falta (B4). undefined: no se pudo leer. */
  recordatorioHoras?: number[];
  /** undefined: no se pudo leer. */
  core?: VistaDeLaConfig | null;
  /** La tabla propia de montos (B23). null: la de por defecto; undefined: no se pudo leer. */
  montos?: RangosDeMonto | null;
  /** Sólo en un espacio del alta automática. undefined: no es uno, o falta la 0048. */
  prueba?: PruebaDelEspacio;
  migracionPendiente: boolean;
}

const DIA_MS = 24 * 60 * 60 * 1000;

function diasDeLaPrueba(fila: { billing_status?: string | null; trial_ends_at?: string | null }, ahora: Date): number | null {
  if (fila.billing_status !== "trial" || fila.trial_ends_at == null) return null;
  if (pruebaVencida(fila, ahora)) return 0;
  return Math.ceil((new Date(fila.trial_ends_at).getTime() - ahora.getTime()) / DIA_MS);
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
  type Fila = {
    emails: string[];
    horas?: number[];
    montos?: RangosDeMonto | null;
    billing_status?: string | null;
    trial_ends_at?: string | null;
    autoalta?: boolean | null;
  };
  // La prueba suma dos lecturas al lote: los datos de la prueba y el número, que por RLS es
  // el del inquilino. De `whatsapp_numeros` sólo sale el estado, ni el número ni los ids.
  const leer = (conPrueba: boolean, conHoras: boolean, conMontos: boolean) =>
    enTenantVarias<[Fila[], VistaDeLaConfig[], { estado: string }[]?]>({ tenantId }, (db) => [
      db
        .select({
          emails: tenants.specialist_alert_emails,
          ...(conHoras ? { horas: tenants.recordatorio_horas } : {}),
          ...(conMontos ? { montos: tenants.rangos_de_monto } : {}),
          ...(conPrueba
            ? {
                billing_status: tenants.billing_status,
                trial_ends_at: tenants.trial_ends_at,
                // `to_jsonb` y no la columna: antes de la 0048 `tenants.autoalta` tira 42703.
                autoalta: sql<boolean | null>`(to_jsonb(${tenants}.*) ->> 'autoalta')::boolean`,
              }
            : {}),
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
      vistaDeLaConfig(db),
      ...(conPrueba
        ? [db.select({ estado: whatsappNumeros.estado }).from(whatsappNumeros).where(ne(whatsappNumeros.estado, "baja")).limit(1)]
        : []),
    ]);
  try {
    // Sin la 0048 falla la tabla de los números, sin la 0040 la columna de los montos y
    // sin la 0039 la de las horas: el resto se lee sin ellas, y el panel que falta no se muestra.
    const sinColumna = (e: unknown, otra: () => ReturnType<typeof leer>) => {
      if (!esFaltaDe0036(e)) throw e;
      return otra();
    };
    const [[fila], [core], numeros] = await leer(true, true, true)
      .catch((e) => sinColumna(e, () => leer(false, true, true)))
      .catch((e) => sinColumna(e, () => leer(false, true, false)))
      .catch((e) => sinColumna(e, () => leer(false, false, false)));
    const estado = numeros?.[0]?.estado;
    return {
      alertas: fila?.emails ?? [],
      recordatorioHoras: fila ? fila.horas : [],
      montos: fila ? fila.montos : null,
      core: core ?? null,
      ...(fila?.autoalta === true
        ? {
            prueba: {
              dias: diasDeLaPrueba(fila, new Date()),
              numero: estado === "conectado" || estado === "suspendido" ? estado : "pedido",
            } satisfies PruebaDelEspacio,
          }
        : {}),
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
