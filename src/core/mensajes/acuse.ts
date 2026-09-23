/**
 * Un mensaje que sólo acusa recibo: «ok», «gracias», «dale, gracias», «👍».
 *
 * A una lista de cinco cosas eso no contesta ninguna. Hasta el ensayo del
 * 23/09 un «ok» cerraba la duda sobre los heridos que venía en la lista, eso
 * contaba como que la persona había contestado, y se le devolvía el pedido
 * entero. Lo que confirma a propósito —«sí», «confirmo», «correcto»— no entra.
 *
 * Mira el mensaje entero: un «ok» con algo abajo ya es otra cosa. Y uno largo
 * no es un acuse, así que ni se prueba la expresión sobre él.
 */

const ACUSE =
  "(?:ok(?:a|ay|ey|i)?|dale|perfecto|listo|genial|joya|b[aá]rbaro|buen[ií]simo|bueno|entendido|de acuerdo|(?:muchas |mil )?gracias|👍|👌|🙏)";
const SOLO_ACUSE = new RegExp(`^${ACUSE}(?:[\\s,.!?]+${ACUSE})*[\\s.!?]*$`, "iu");

const MAX_LARGO = 80;

export function esSoloUnAcuse(texto?: string | null): boolean {
  const limpio = (texto ?? "").trim();
  return limpio.length <= MAX_LARGO && SOLO_ACUSE.test(limpio);
}
