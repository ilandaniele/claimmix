/**
 * Cuánto se le da al modelo para contestar.
 *
 * Vive solo, en un archivo sin dependencias, porque lo necesitan dos lugares
 * que no deberían conocerse: el extractor, que lo usa como `AbortSignal`, y el
 * worker, que antes de empezar comprueba que la llamada ENTERA entre en lo que
 * le queda de presupuesto.
 *
 * Estaba sólo en el extractor y el worker lo importaba de ahí — un módulo de
 * veintidós dependencias arrastrado a la ruta caliente por un número. Y la
 * alternativa, copiarlo, son dos constantes que tienen que coincidir en dos
 * archivos: o sea dos constantes que en algún momento dejan de coincidir.
 *
 * ── De dónde sale el número ─────────────────────────────────────────────────
 *
 * Estaba en 20 s, y ese corte era NUEVO: la columna `timeout` de
 * `provider_usage_events` existía desde el día uno y nunca se había escrito,
 * porque no había nada que cortara por tiempo. Los ochenta timeouts del 09/09
 * no son «el modelo se puso lento»: son el corte estrenándose.
 *
 * Medido sobre 10.834 extracciones exitosas:
 *
 *     p50 6.259 ms · p90 9.321 ms · p95 14.627 ms · p99 35.823 ms
 *
 * y el p95 POR DÍA se mueve entre 8.444 y 47.169 ms. El 08/09, con el corte
 * todavía sin estrenar, 37 de 373 llamadas tardaron más de 20 s y terminaron
 * bien: con 20 s, esas 37 morían.
 *
 * Treinta deja pasar hasta cerca del p99 y sigue entrando en el presupuesto de
 * 40 s de la corrida — porque un timeout ya no reintenta. Con reintento no
 * entraría: 2 × 30 s son 60 s, que es la función entera.
 */
export const PLAZO_DEL_MODELO_MS = 30_000;
