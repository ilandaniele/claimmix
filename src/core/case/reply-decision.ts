/**
 * ¿Le contestamos, le acusamos recibo, o nos callamos?
 *
 * Es la decisión central del producto —si el asegurado recibe un mensaje o no—
 * y hasta acá vivía enredada entre consultas a la base, dentro de una función
 * de mil cuatrocientas líneas. Para probarla había que montar media aplicación.
 *
 * Acá no hay base, ni red, ni reloj: entran siete señales y sale una decisión.
 * Se prueba con siete booleanos.
 *
 * ── Por qué cada señal está ────────────────────────────────────────────────
 *
 * Las reglas de abajo no son de diseño: cada una viene de algo que salió mal
 * con gente de verdad del otro lado.
 *
 * **No repetir el pedido.** Mandar la misma lista de datos faltantes dos veces
 * es hostigamiento, y del otro lado se lee como que nadie está leyendo.
 *
 * **Pero callarse no es lo mismo que no tener nada que decir.** Alguien que
 * contesta «fue un choque, ayer a la tarde» mientras siguen faltando el nombre,
 * la póliza y el DNI no cambió el pedido: la regla de no repetirse lo deja en
 * silencio, y eso se lee como que su mensaje no llegó a ninguna parte. Que es
 * el problema que este producto existe para arreglar.
 *
 * **Y «nos enteramos de algo nuevo» por sí solo no alcanza.** La extracción
 * relee la conversación entera en cada vuelta, así que un «ok» puede producir
 * campos que antes no estaban guardados —de mensajes viejos, no del último—.
 * Con esa señal sola, un «ok» y un «gracias» recibían un acuse cada uno: el
 * mismo hostigamiento, con otra plantilla. Por eso se respeta el juicio del
 * agente: si deliberó y dijo que esperaba, ya decidió que el mensaje no aportó.
 *
 * **La severidad alta manda callar.** Un caso grave lo toma una persona; el
 * agente no debe adelantarse con un mensaje automático.
 */

/** Lo que se sabe del caso en el momento de decidir. */
export type SeñalesDeRespuesta = {
  /** ¿Ya se le pidió exactamente esto antes? */
  readonly yaSePidio: boolean;
  /** ¿El agente deliberó y decidió esperar? Es su juicio sobre el último mensaje. */
  readonly elAgenteEspera: boolean;
  /** ¿Hay una pregunta suya sin responder? Una pregunta gana sobre el silencio. */
  readonly nosPreguntoAlgo: boolean;
  /** ¿Llegó un archivo desde la última vez que hablamos? */
  readonly llegoUnArchivo: boolean;
  /** ¿Aparecieron datos que antes no teníamos? */
  readonly aprendimosAlgo: boolean;
  /** Cuántos datos faltan todavía. Cero significa que no hay nada que pedir. */
  readonly datosQueFaltan: number;
  /** ¿El caso es grave? Entonces lo toma una persona. */
  readonly esGrave: boolean;
};

/**
 * Qué hacer con el asegurado.
 *
 *   pedir          mandarle la lista de lo que falta
 *   acusar-recibo  decirle que tomamos nota, sin repetir la lista
 *   callar         no mandar nada
 */
export type QueHacer = "pedir" | "acusar-recibo" | "callar";

/**
 * ¿El pedido queda en espera?
 *
 * Se separa porque el orquestador también la usa para decidir el estado del
 * caso: un pedido en espera deja el caso bloqueado aunque no salga ningún
 * mensaje.
 */
export function elPedidoQuedaEnEspera(s: SeñalesDeRespuesta): boolean {
  return (s.yaSePidio || s.elAgenteEspera) && !s.nosPreguntoAlgo && !s.llegoUnArchivo;
}

export function queHacer(s: SeñalesDeRespuesta): QueHacer {
  // Un caso grave lo atiende una persona. Antes que cualquier otra cosa.
  if (s.esGrave) return "callar";

  const enEspera = elPedidoQuedaEnEspera(s);

  // Hay algo que pedir y no se pidió todavía —o algo cambió desde que se pidió.
  if (s.datosQueFaltan > 0 && !enEspera) return "pedir";

  // El pedido está en espera, pero el asegurado contó algo. Un acuse corto:
  // tomamos nota, seguimos esperando lo de antes. Sin la lista — volver a
  // ponerla es exactamente lo que la regla de no repetirse evita.
  //
  // `!elAgenteEspera` es la condición que faltó la primera vez, y sin ella un
  // «ok» recibía acuse.
  if (enEspera && !s.elAgenteEspera && s.aprendimosAlgo) return "acusar-recibo";

  return "callar";
}
