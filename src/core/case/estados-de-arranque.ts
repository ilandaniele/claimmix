/**
 * Desde qué estados el worker arranca a leer un mensaje nuevo.
 *
 * Vive solo, como `reserva-de-extraccion`: lo leen el worker, que decide si
 * lee, y el barrido de pendientes, que no retoma lo que el worker no va a leer.
 * `requiere_especialista` y `escalado` quedan afuera: el caso lo tiene una persona.
 */
export const ESTADOS_DE_ARRANQUE = [
  "recibido",
  "procesando",
  "info_faltante",
  "confirmacion_pendiente",
] as const;

export function puedeArrancar(status: string): boolean {
  return (ESTADOS_DE_ARRANQUE as readonly string[]).includes(status);
}
