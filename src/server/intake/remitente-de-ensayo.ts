/**
 * De qué dirección dice venir un siniestro simulado.
 *
 * Esto es lo que de verdad impide que un ensayo termine mandándole un mail a
 * una persona, y hasta acá funcionaba por casualidad en la mitad de los casos.
 *
 * ── Cómo se corta un envío, de verdad ───────────────────────────────────────
 *
 * `dispatch.ts` mira `isReservedTestAddress(to)` — la DIRECCIÓN del
 * destinatario, no el canal. Y ese `to` sale de acá: se guarda como `from_addr`
 * en `raw_messages`, el worker lo lee como `senderEmail`, y el orquestador lo
 * usa de `to:` cuando le contesta al asegurado.
 *
 * Ojo con «pero el canal es email_sim», que es lo que uno supone:
 *
 *   · `dispatch.ts` no mira el canal en ningún lado.
 *   · `messengerFor` devuelve el mensajero simulado SÓLO para `whatsapp_sim`;
 *     un `email_sim` cae en el mensajero de verdad.
 *   · El único lugar que sí filtra por canal es la alerta al especialista, y
 *     ni ese alcanzó solo: tuvo que volver a preguntar por la dirección del
 *     remitente, con un comentario que cuenta que costó una bandeja llena.
 *
 * Antes, en modo escenario había un nombre y salía `nombre@example.com`, que la
 * guarda reconoce. En modo texto libre no había nombre y quedaba `null`, que
 * termina como `to: ""` — e `isReservedTestAddress("")` devuelve FALSE. No lo
 * frenaba la guarda: lo frenaba que Gmail no puede mandar a una dirección
 * vacía. Suerte, no diseño, y el día que alguien tocara ese detalle
 * —que parece cosmético— desaparecía la única protección real.
 */

import "server-only";

/**
 * Siempre una dirección reservada, nunca nula, aunque no haya nombre.
 *
 * El nombre se limpia hasta lo que puede ir a la izquierda de un arroba: sin
 * acentos, sin apóstrofos, sin eñes. Un `from_addr` inválido vuelve al problema
 * de antes —la guarda no lo reconoce y lo que frena el envío es el error del
 * proveedor—, y los nombres de los escenarios tienen de todo.
 */
export function remitenteDeEnsayo(nombre: string | null | undefined): string {
  const usuario = (nombre ?? "")
    .normalize("NFD")
    // Se sacan las marcas diacríticas: «José» → «Jose», «Ñandú» → «Nandu».
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9.]/g, "")
    // Un punto al principio o al final, o dos seguidos, no es una dirección
    // válida y hay nombres que los producen («Ana  María», «O'Higgins»).
    .replace(/\.{2,}/g, ".")
    .replace(/^\.|\.$/g, "");

  return `${usuario || "ensayo"}@example.com`;
}
