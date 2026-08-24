/**
 * Los números que este sistema inventa, y a los que no le escribe a nadie.
 *
 * Las pruebas necesitan asegurados que no existen. El ensayo de conversaciones,
 * la prueba de carga y el timbre usan el bloque `5490000…`, que no es un móvil
 * argentino válido: no le pertenece a ninguna persona y nunca va a pertenecerle.
 *
 * El freno vivía sólo en el mensajero simulado, y eso alcanzaba mientras la
 * única forma de inventar un asegurado fuera el camino simulado. Deja de
 * alcanzar en cuanto una prueba entra por el webhook firmado —el camino real—,
 * porque ahí contesta el mensajero de verdad y el intento de envío sale hacia
 * Meta.
 *
 * Y ese intento es caro de un modo particular: escribirle a números inventados
 * es de las cosas por las que Meta restringe una cuenta de WhatsApp Business.
 * O sea que la prueba que sirve para no romper producción sería la que hace que
 * nos bloqueen el canal. Por eso la restricción se mueve acá, al número, donde
 * vale para todos los caminos: si el destino es de este bloque, no sale, venga
 * de donde venga.
 */

/**
 * El bloque reservado para asegurados inventados.
 *
 * Se compara sobre los dígitos: un número puede llegar como "+54 9 0000…" o
 * "5490000…" según quién lo escriba, y la diferencia es de formato, no de
 * destinatario.
 */
const RESERVED_PREFIXES = ["5490000"];

/** ¿Este número es de una persona, o lo inventamos nosotros? */
export function isReservedTestNumber(to: string | null | undefined): boolean {
  if (!to) return false;
  const digits = to.replace(/\D/g, "");
  if (!digits) return false;
  return RESERVED_PREFIXES.some((prefix) => digits.startsWith(prefix));
}
