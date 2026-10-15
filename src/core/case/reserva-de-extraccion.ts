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

/**
 * Cuánto dura la más corta de las funciones que corren esta extracción
 * (`/api/intake/simulate`, 180 s). Es el corte que se supone cuando quien llama
 * no dice cuál es el suyo: pasarse de ese número mata la invocación donde esté.
 */
export const FUNCION_MAS_CORTA_MS = 180_000;

/** Si la reserva sigue viva: hay una corrida en curso, o pudo haberla. */
export function reservaViva(leaseAt: string | null, ahora: Date): boolean {
  if (!leaseAt) return false;
  return ahora.getTime() - new Date(leaseAt).getTime() < RESERVA_DE_EXTRACCION_MS;
}
