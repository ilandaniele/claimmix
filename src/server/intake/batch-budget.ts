/**
 * Cuántos casos de un lote entran en esta invocación, y cuándo hay que pasarle
 * el resto a la siguiente.
 *
 * Un lote se procesa en serie y a propósito: las extracciones simuladas se
 * turnan (simulation-throttle) para no golpear al modelo con cincuenta llamadas
 * a la vez, así que cada caso cuesta su extracción más el piso entre turnos.
 * Con eso, un lote grande tarda más que el techo de una función.
 *
 * Lo que pasaba entonces era silencioso: la invocación se cortaba a mitad del
 * recorrido, los casos que faltaban quedaban en `procesando` para siempre y el
 * reaper los pasaba a `escalado` un día después. El lote decía "50 aceptadas" y
 * el tablero terminaba con treinta y pico procesadas y el resto en el limbo —
 * que para entrenar es peor que perderlas del todo, porque la distribución que
 * se quería sembrar queda sesgada hacia los primeros escenarios de la lista.
 *
 * La decisión de seguir o no se toma con lo que ya costó, no con una estimación
 * escrita a mano: un caso puede tardar tres segundos o cuarenta según el
 * escenario y cómo venga el modelo ese día.
 */

/** Cuánto de la invocación se usa antes de pasar el resto. */
export const BATCH_BUDGET_MS = 240_000;

/**
 * Estimación del primer caso, antes de tener uno medido.
 *
 * Pesimista a propósito: si el primero resulta más barato, la medición real lo
 * corrige en la vuelta siguiente. Al revés no — un optimista arranca un caso
 * que no llega a terminar, y ese es justamente el que se pierde.
 */
export const FIRST_CASE_ESTIMATE_MS = 15_000;

/** Cuántas veces puede un lote pasarle el resto a otra invocación. */
export const MAX_CHAIN = 6;

/**
 * ¿Alcanza el tiempo para uno más?
 *
 * @param elapsedMs   lo que va corriendo esta invocación
 * @param processed   casos terminados en esta invocación
 * @param budgetMs    techo que se le da a esta invocación
 */
export function fitsAnotherCase(
  elapsedMs: number,
  processed: number,
  budgetMs: number = BATCH_BUDGET_MS
): boolean {
  const perCase = processed > 0 ? elapsedMs / processed : FIRST_CASE_ESTIMATE_MS;
  return elapsedMs + perCase <= budgetMs;
}
