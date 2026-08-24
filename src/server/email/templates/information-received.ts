/**
 * Email template: information_received
 *
 * El mensaje corto que va cuando la persona contó algo nuevo y lo que falta
 * sigue siendo exactamente lo mismo que ya le pedimos.
 *
 * Antes ahí no salía nada. La regla de no repetirse es correcta —tres mensajes
 * en noventa segundos pidiendo el mismo parte amistoso es hostigar, no hacer
 * seguimiento— pero de "no repetir el pedido" no se sigue "no decir nada". La
 * persona escribió, le contestó a alguien, y del otro lado no pasó nada: el
 * silencio se lee como que no hay nadie leyendo, que es el problema que este
 * producto existe para arreglar.
 *
 * Así que se acusa recibo y no se repite la lista. Las dos cosas a la vez:
 *
 *   "Gracias, anotamos que fue un choque de ayer a la tarde. Seguimos a la
 *    espera de lo que te pedimos antes para poder avanzar."
 *
 * Sin la lista, porque se la mandamos hace un momento y volver a ponerla es
 * exactamente lo que la regla evita. Y sin decir que está completo, porque no
 * lo está — decirlo sería peor que preguntar dos veces: sería falso.
 */

export interface InformationReceivedData {
  caseId: string;
  /** En castellano y en palabras de la persona: "un choque de ayer a la tarde". */
  noted?: string | null;
}

export function renderInformationReceived(data: InformationReceivedData): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Tomamos nota - Caso #${data.caseId}`;

  // Sin dato concreto que nombrar, "tomamos nota de lo que nos contaste" sigue
  // siendo verdad y sigue siendo mejor que el silencio. Lo que no se hace es
  // inventar un detalle para que la frase suene más atenta.
  const notedPhrase = data.noted ? ` de ${data.noted}` : " de lo que nos contaste";

  const html = `
    <p>Gracias, tomamos nota${notedPhrase}.</p>
    <p>Seguimos a la espera de lo que te pedimos antes para poder avanzar con tu reclamo.</p>
    <p>Caso #${data.caseId}</p>
  `.trim();

  const text = [
    `Gracias, tomamos nota${notedPhrase}.`,
    "",
    "Seguimos a la espera de lo que te pedimos antes para poder avanzar con tu reclamo.",
    "",
    `Caso #${data.caseId}`,
  ].join("\n");

  return { subject, html, text };
}
