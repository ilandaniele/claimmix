/**
 * Las reglas de la revisión nocturna de calidad (B22).
 *
 * Cada noche, colgada del barrido de `reap-stuck`, se buscan los casos que se
 * salieron de lo esperado y se guarda un desvío por cada uno. Un desvío es
 * (caso, regla, ancla): el ancla es el instante del hecho que lo causó, así que
 * la misma situación se guarda una sola vez por más noches que corra el barrido,
 * y una situación nueva del mismo caso es otro desvío.
 *
 * Las cuentas van en SQL (`server/desvios/revision-nocturna.ts`): comparar
 * cientos de casos contra su historial de auditoría en memoria sería traer la
 * auditoría entera. Acá vive lo que comparten el barrido y la pantalla: los
 * nombres de las reglas, los plazos y cómo se lee el dato que guarda cada una.
 *
 * Es sólo del equipo. Nada de esto sale al asegurado, al prompt ni a las
 * plantillas.
 */

import type { ClaveDelServidor } from "@/lib/i18n/es-AR.servidor";

export const REGLAS = [
  "doc_sin_recibir",
  "cierre_sin_listo",
  "derivacion_sin_respuesta",
  "plazo_vencido",
  "plan_sin_terminar",
] as const;
export type Regla = (typeof REGLAS)[number];

/** Cómo se llama cada regla de cara a una persona: la pantalla y el aviso diario leen la misma clave. */
export const TITULO_DE_REGLA: Record<Regla, ClaveDelServidor> = {
  doc_sin_recibir: "desvios.regla.docSinRecibir",
  cierre_sin_listo: "desvios.regla.cierreSinListo",
  derivacion_sin_respuesta: "desvios.regla.derivacionSinRespuesta",
  plazo_vencido: "desvios.regla.plazoVencido",
  plan_sin_terminar: "desvios.regla.planSinTerminar",
};

/** Un documento que se pidió y a las 72 h sigue sin llegar (ni fue declarado inexistente). */
export const HORAS_DOC_SIN_RECIBIR = 72;

/** Una derivación al especialista a la que nadie del equipo le tocó el caso en un día. */
export const HORAS_DERIVACION_SIN_RESPUESTA = 24;

/**
 * Cuántos días hacia atrás se miran los casos que ya cerraron.
 *
 * Es un tope para no revisar todo el historial cada noche. Lo que evita los
 * desvíos falsos de casos viejos, que no dejaron rastro de haber pasado por
 * `listo` porque el cambio de estado del agente todavía no se auditaba, es
 * otra guarda: la regla sólo mira casos abiertos después del primer cambio
 * auditado (ver `cierre_sin_listo` en `revision-nocturna.ts`).
 */
export const DIAS_DE_VENTANA_DEL_CIERRE = 30;

/** Los casos de ensayo no miden nada: los mismos que el barrido de recordatorios deja afuera. */
export const CANALES_SIMULADOS = ["email_sim", "whatsapp_sim"] as const;

const CLAVE = /^[a-z][a-z0-9_]{0,39}$/;
const TOPE_DE_CLAVES = 10;

/**
 * Las claves que guardó el desvío en `dato`, separadas por coma: la del
 * documento que falta, el estado en que cerró, el plazo que venció, el paso del
 * plan sin hacer. Todas salen de nombres cerrados o de claves con formato fijo,
 * pero el barrido escribe con el rol dueño: se vuelve a validar al leer, y lo
 * que no tenga forma de clave se descarta en vez de mostrarse.
 */
export function clavesDelDato(dato: string | null): string[] {
  if (!dato) return [];
  return dato
    .split(",")
    .map((c) => c.trim())
    .filter((c) => CLAVE.test(c))
    .slice(0, TOPE_DE_CLAVES);
}
