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

  return (
    `La póliza figura a nombre de ${padron} y vos nos decís que sos ${dijo}. ` +
    `El especialista va a revisar esa diferencia; si querés, contanos qué relación tenés con el titular.`
  );
}
