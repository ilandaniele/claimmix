
import { escapeHtml } from "@/server/email/render";
import { textoAHtml } from "@/core/email/html";/**
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
  /**
   * El nombre de pila, cuando el caso ya lo tiene.
   *
   * El orquestador lo mandaba y este armador lo descartaba. (Acá vivía `noted`,
   * el detalle que se iba a nombrar: nadie lo seteó nunca, ni por mail ni por
   * WhatsApp, y estaba declarado en los dos escritores.)
   */
  claimantName?: string | null;
  /** La prosa ya redactada. Reemplaza el cuerpo y nada más. */
  cuerpo?: string | null;
}

export function renderInformationReceived(data: InformationReceivedData): {
  subject: string;
  html: string;
  text: string;
  cuerpo: string;
} {
  const subject = `Tomamos nota - Caso #${data.caseId}`;

  // El nombre delante y la mayúscula en la misma expresión: sin nombre la
  // oración empieza igual de entera.
  const nombre = data.claimantName?.trim();
  const saludo = nombre ? `${nombre}, ` : "";
  const gracias = nombre ? "gracias" : "Gracias";

  const cuerpo = [
    `${saludo}${gracias}, tomamos nota de lo que nos contaste.`,
    "",
    "Seguimos a la espera de lo que te pedimos antes para poder avanzar con tu reclamo.",
  ].join("\n");
  const redactado = data.cuerpo?.trim();

  // Sigue siendo un FRAGMENTO de `<p>`, sin DOCTYPE: convertirlo en documento
  // entero cambiaría lo que Gmail recibe hoy en esta rama sin que nadie lo pida.
  const prosaHtml = redactado
    ? textoAHtml(redactado)
    : `<p>${escapeHtml(`${saludo}${gracias}, tomamos nota de lo que nos contaste.`)}</p>
    <p>Seguimos a la espera de lo que te pedimos antes para poder avanzar con tu reclamo.</p>`;

  const html = `
    ${prosaHtml}
    <p>Caso #${escapeHtml(data.caseId)}</p>
  `.trim();

  const text = [redactado ?? cuerpo, "", `Caso #${data.caseId}`].join("\n");

  return { subject, html, text, cuerpo };
}
