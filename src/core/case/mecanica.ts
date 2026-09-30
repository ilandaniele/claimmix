/**
 * La mecánica de un choque tal como la cuenta el relato o un parte: hechos
 * cerrados, sin texto libre.
 *
 * Los devuelve la misma extracción que ya corre (no hay una llamada aparte) y
 * cada campo se ataja por su cuenta: un valor fuera de la lista queda en null
 * en vez de tirar la lectura entera. `null` es «no lo dice», y el modelo no
 * infiere el semáforo ni quién venía por la derecha.
 */

import { z } from "zod";

export const MANIOBRAS = [
  "avanzaba_recto",
  "giraba_izquierda",
  "giraba_derecha",
  "retrocedia",
  "cambiaba_carril",
  "estacionado",
  "detenido",
  "otra",
] as const;

export const SEMAFOROS = ["verde", "amarillo", "rojo", "sin_semaforo", "no_dice"] as const;

export const PARTES = ["asegurado", "tercero"] as const;

export type Maniobra = (typeof MANIOBRAS)[number];
export type Semaforo = (typeof SEMAFOROS)[number];
export type Parte = (typeof PARTES)[number];

const enumNulo = <T extends readonly [string, ...string[]]>(valores: T) => z.enum(valores).nullable().catch(null);
const booleanoNulo = z.boolean().nullable().catch(null);

export const MecanicaSchema = z.object({
  maniobra_asegurado: enumNulo(MANIOBRAS),
  maniobra_tercero: enumNulo(MANIOBRAS),
  semaforo_asegurado: enumNulo(SEMAFOROS),
  semaforo_tercero: enumNulo(SEMAFOROS),
  /** ¿Chocaron en el cruce de dos calles? */
  interseccion: booleanoNulo,
  /** true: el asegurado venía por la derecha del tercero. false: el tercero venía por la derecha del asegurado. */
  venia_por_la_derecha: booleanoNulo,
  /** Quién le pegó al otro desde atrás. */
  embistio_de_atras: enumNulo(PARTES),
  /** El tercero venía por una vía con prioridad, era un vehículo de emergencia, había pare o rotonda, o el asegurado giraba. */
  excepcion_prioridad: booleanoNulo,
});

export type Mecanica = z.infer<typeof MecanicaSchema>;

export const CAMPOS_DE_MECANICA = Object.keys(MecanicaSchema.shape) as Array<keyof Mecanica>;

const conNulo = (valores: readonly string[]) => ({ type: ["string", "null"], enum: [...valores, null] });

/** El fragmento del esquema JSON que se le pide al modelo, de las mismas listas que valida Zod. */
export const mecanicaJson = {
  type: ["object", "null"],
  properties: {
    maniobra_asegurado: conNulo(MANIOBRAS),
    maniobra_tercero: conNulo(MANIOBRAS),
    semaforo_asegurado: conNulo(SEMAFOROS),
    semaforo_tercero: conNulo(SEMAFOROS),
    interseccion: { type: ["boolean", "null"] },
    venia_por_la_derecha: { type: ["boolean", "null"] },
    embistio_de_atras: conNulo(PARTES),
    excepcion_prioridad: { type: ["boolean", "null"] },
  },
  required: CAMPOS_DE_MECANICA,
  additionalProperties: false,
};

/** ¿Dice algo la mecánica? Un bloque con todo en null no cuenta como fuente. */
export function tieneMecanica(m: Mecanica | null | undefined): m is Mecanica {
  return !!m && CAMPOS_DE_MECANICA.some((c) => m[c] !== null);
}
