import "server-only";

import { enTenant } from "@/data/scope";
import { urlDeVueltaDelSso } from "@/lib/auth/base-url";

import { esFaltaDe0045, vistaDeLaConfigSso, type VistaDeLaConfigSso } from "./config";
import { registroDeVerificacion } from "./dominio";

/**
 * Lo que ve un admin de su SSO: la config sin el secreto (sólo si hay uno), el
 * registro DNS que tiene que publicar y la dirección de vuelta que tiene que
 * registrar en su IdP. Lo arman la API y /configuracion con esta misma función.
 */
export type PanelSso = {
  issuer: string | null;
  client_id: string | null;
  dominio: string | null;
  dominio_verificado_en: string | null;
  activo: boolean;
  exigir: boolean;
  tiene_secreto: boolean;
  registro: { nombre: string; valor: string } | null;
  url_de_vuelta: string;
  /** Falta aplicar la 0045: el panel avisa en lugar de ofrecer un formulario que no va a guardar. */
  migracion_pendiente: boolean;
};

export function armarPanel(
  tenantId: string,
  fila: Partial<VistaDeLaConfigSso> | undefined,
  migracionPendiente = false
): PanelSso {
  const dominio = fila?.dominio ?? null;
  return {
    issuer: fila?.issuer ?? null,
    client_id: fila?.client_id ?? null,
    dominio,
    dominio_verificado_en: fila?.dominio_verificado_en ?? null,
    activo: fila?.activo ?? false,
    exigir: fila?.exigir ?? false,
    tiene_secreto: fila?.tiene_secreto ?? false,
    registro: dominio ? registroDeVerificacion(tenantId, dominio) : null,
    url_de_vuelta: urlDeVueltaDelSso(),
    migracion_pendiente: migracionPendiente,
  };
}

/** Una consulta. Sin fila (nunca configuró nada) el panel viene vacío. */
export async function panelSso(tenantId: string): Promise<PanelSso> {
  try {
    const [fila] = await enTenant({ tenantId }, (db) => vistaDeLaConfigSso(db));
    return armarPanel(tenantId, fila);
  } catch (e) {
    if (esFaltaDe0045(e)) return armarPanel(tenantId, undefined, true);
    throw e;
  }
}
