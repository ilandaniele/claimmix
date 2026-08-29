/**
 * En qué estado queda el caso apenas termina de leerse el mensaje.
 *
 * OJO CON EL NOMBRE, porque es fácil confundirse: esto NO es «el estado del
 * caso». Es el estado que deja la extracción, y para los cuatro canales que el
 * worker atiende viene después `orchestratePostExtraction`, que vuelve a mirar
 * el caso con más información —las brechas ya analizadas, los conflictos con el
 * padrón, lo que ya se le pidió al asegurado— y muchas veces lo pisa.
 *
 * O sea: es un intermedio. Si alguna vez alguien quiere «unificar las dos
 * decisiones de estado», que empiece por acá y sepa que son dos a propósito:
 * ésta decide con lo que dijo el extractor, la otra con lo que sabe el caso.
 *
 * Vivía en línea adentro de `runEmailExtractionWorker`, una función de más de
 * setecientas líneas, entre consultas a la base. Trece líneas puras que no
 * probaba nadie: las cuatro ramas no tenían una sola afirmación en toda la
 * suite, así que invertir dos `if` no rompía nada.
 */

/**
 * Los cuatro estados que la extracción puede dejar.
 *
 * Deliberadamente NO es `CaseStatus`, que tiene catorce miembros e incluye
 * `cerrado`, `enviado_a_core` y `error_core`. El encabezado de `fsm.ts` dice
 * que el worker de IA no puede fijar estados terminales; declarar el retorno
 * ancho lo habilitaría por tipos a cerrar un caso.
 */
export type EstadoTrasExtraer =
  | "requiere_especialista"
  | "info_faltante"
  | "confirmacion_pendiente"
  | "listo";

/** Lo que se sabe del mensaje recién leído. */
export type SeñalesDeExtraccion = {
  /** ¿La severidad pide que lo tome una persona? */
  readonly necesitaEspecialista: boolean;
  /**
   * Cuántos datos faltan: los que salieron con confianza baja más los que el
   * extractor declaró faltantes.
   */
  readonly camposFaltantes: number;
  /** Cuántos datos el extractor leyó pero no se anima a dar por buenos. */
  readonly camposPorConfirmar: number;
};

/**
 * El orden de las preguntas ES la regla, y no es intercambiable.
 *
 *   1. Grave gana sobre todo. Si hay que escalar, escala, aunque falten datos:
 *      lo que sigue lo decide una persona y no tiene sentido pedirle nada al
 *      asegurado mientras tanto.
 *   2. Falta un dato gana sobre dudar de otro. Pedir lo que no está es más
 *      urgente que confirmar lo que sí: sin el dato no se puede avanzar, con
 *      el dudoso sí —mal, pero se puede—.
 *   3. Recién ahí, confirmar.
 *   4. Y si no hay nada de eso, está listo para que lo revisen.
 */
export function estadoTrasExtraer(señales: SeñalesDeExtraccion): EstadoTrasExtraer {
  if (señales.necesitaEspecialista) return "requiere_especialista";
  if (señales.camposFaltantes > 0) return "info_faltante";
  if (señales.camposPorConfirmar > 0) return "confirmacion_pendiente";
  return "listo";
}
