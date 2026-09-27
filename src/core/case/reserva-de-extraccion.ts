/**
 * Cuánto dura la reserva de extracción de un caso (`extraction_lease_at`).
 *
 * Al menos lo que dura la función más larga que corre el agente (300 s): si vence
 * con la corrida viva, otra toma el caso y corren dos a la vez. Y no mucho
 * más: si la función muere, el caso espera esto para que alguien lo retome.
 *
 * Vive solo, como `plazo-del-modelo`: lo leen el worker, que la toma, y el
 * barrido de pendientes, que la da por vencida.
 */
export const RESERVA_DE_EXTRACCION_MS = 5 * 60_000;

/** Si la reserva sigue viva: hay una corrida en curso, o pudo haberla. */
export function reservaViva(leaseAt: string | null, ahora: Date): boolean {
  if (!leaseAt) return false;
  return ahora.getTime() - new Date(leaseAt).getTime() < RESERVA_DE_EXTRACCION_MS;
}
