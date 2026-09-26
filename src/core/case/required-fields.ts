/**
 * Qué datos pide cada ramo, más allá de los campos base de todo caso.
 *
 * Distinto de `required-docs.ts`, que lista documentos (fotos, presupuestos).
 * Esto lista datos: cosas que la persona puede simplemente contestar.
 */

import type { ClaimType } from "@/lib/schemas/cases";

/**
 * `incendio` y `robo_contenido` son, en este producto, siniestros de auto: un
 * incendio de vehículo y un robo de contenido DE un vehículo. Por eso piden
 * patente igual que choque o robo.
 */
export const CAMPOS_REQUERIDOS_POR_RAMO: Record<ClaimType, readonly string[]> = {
  choque: ["patente_vehiculo", "provincia_siniestro", "hora_siniestro"],
  rc: ["patente_vehiculo", "provincia_siniestro", "hora_siniestro"],
  robo: ["patente_vehiculo", "provincia_siniestro"],
  granizo: ["patente_vehiculo", "provincia_siniestro"],
  incendio: ["patente_vehiculo", "provincia_siniestro"],
  cristales: ["patente_vehiculo", "provincia_siniestro"],
  robo_contenido: ["patente_vehiculo", "provincia_siniestro"],
  accidente_personal: ["provincia_siniestro"],
  other: ["provincia_siniestro"],
};

/** Ramo desconocido o vacío: sin campos extra. */
export function camposRequeridosDelRamo(
  claimType: string | null | undefined
): readonly string[] {
  if (!claimType) return [];
  return CAMPOS_REQUERIDOS_POR_RAMO[claimType as ClaimType] ?? [];
}

/**
 * Otras claves que, si están, dan por satisfecho el campo requerido.
 *
 * `party_b_plate` queda deliberadamente afuera: la patente de un tercero nunca
 * satisface la del asegurado.
 */
export const SATISFECHO_POR: Record<string, readonly string[]> = {
  patente_vehiculo: ["party_a_plate", "vehicle_plate", "patente"],
  provincia_siniestro: ["provincia"],
  hora_siniestro: ["accident_time", "hora"],
};

/** La clave pedida, más las que también la satisfacen. */
export function clavesQueSatisfacen(clave: string): readonly string[] {
  return [clave, ...(SATISFECHO_POR[clave] ?? [])];
}
