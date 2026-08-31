/**
 * Qué día es, acá.
 *
 * El servidor corre en UTC y Buenos Aires está tres horas atrás, así que entre
 * las 21 y las 24 hora local `new Date().toISOString().slice(0, 10)` ya devuelve
 * el día siguiente. Tres horas por día, todos los días — la séptima parte de la
 * jornada, y justo la franja en la que la gente maneja de vuelta a la casa.
 *
 * Dónde importaba:
 *
 * · La vigencia de la póliza. Una con `end_date` de HOY figuraba vencida a las
 *   22:10, así que alguien que chocaba el último día de su cobertura recibía
 *   «tu póliza venció el …» y el caso se derivaba como póliza vencida. Está
 *   cubierto y se le decía que no.
 * · La fecha que se le muestra al modelo en la conversación: «recibido el 28»
 *   para un mensaje que llegó el 27 a la noche.
 * · El nombre del CSV exportado.
 *
 * `en-CA` no es una elección exótica: es el locale que da `AAAA-MM-DD`, que es
 * el formato con el que la base guarda las fechas y con el que se comparan.
 */

/** La zona en la que vive el negocio. */
export const ZONA_ARGENTINA = "America/Argentina/Buenos_Aires";

/**
 * El día de una fecha en la Argentina, como `AAAA-MM-DD`.
 *
 * @param cuando La fecha a mirar. Por omisión, ahora.
 */
export function diaArgentino(cuando: Date = new Date()): string {
  return cuando.toLocaleDateString("en-CA", { timeZone: ZONA_ARGENTINA });
}
