/**
 * Los dos valores que no coinciden, dichos.
 *
 * Quien escribe por la póliza de otro —un familiar del titular— recibe que su
 * caso pasó a una persona y no tiene con qué contestar: no sabe cuál de los dos
 * nombres estamos mirando. Nombrarlos es AC7/AC9.
 *
 * Vive acá y no adentro de una plantilla porque los dos canales dicen lo mismo.
 * Estaba sólo en la de correo, y por WhatsApp el mismo caso salía sin los
 * valores: la misma promesa cumplida en un canal y no en el otro es peor que
 * incumplida en los dos, porque nadie la mira.
 */

import { AVISO_DE_TRASPASO } from "./traspaso";

/*
 * El pedido de confirmación cuando quien escribe no es el titular.
 *
 * «¿Cuál es el correcto?» no tiene respuesta: la póliza es del padre y el
 * nombre es de la hija, los dos valores son correctos. Y el caso ya quedó
 * derivado en esa vuelta, así que tampoco hay nadie del lado del agente que
 * lea lo que conteste. Se nombra la diferencia y se dice qué pasa.
 */
export const NO_COINCIDE_CON_EL_TITULAR =
  "Los datos que nos pasaste no coinciden con los del titular de la póliza:";
export const LO_REVISA_UN_ESPECIALISTA =
  `Como la póliza está a nombre de otra persona, un especialista va a revisar tu caso y se va a comunicar con vos. ${AVISO_DE_TRASPASO}`;

export interface TitularQueNoCoincide {
  /** El titular del padrón, en iniciales: «R*** P***». Nunca el nombre entero. */
  titularIniciales?: string | null;
  /** El nombre que dio quien escribe, tal cual lo escribió. */
  claimantName?: string | null;
}

/**
 * Sale sólo cuando están los dos. Un escalado por severidad no tiene por qué
 * mencionar ningún padrón, y el del padrón sin el que dijo la persona es una
 * acusación sin término de comparación.
 */
export function laDiferencia(data: TitularQueNoCoincide): string | null {
  const padron = data.titularIniciales?.trim();
  const dijo = data.claimantName?.trim();
  if (!padron || !dijo) return null;

  // Sin invitar a contestar: va detrás del aviso de traspaso, y por este medio ya no lee nadie.
  return (
    `La póliza figura a nombre de ${padron} y vos nos decís que sos ${dijo}. ` +
    `El especialista va a revisar esa diferencia.`
  );
}
