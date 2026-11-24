/**
 * Lo que se le dice a alguien cuya nota de voz no se pudo transcribir.
 *
 * El acuse sale porque llegó el archivo, no porque se leyó lo que dijo: decir
 * «tomamos nota de lo que nos contaste» afirma un contenido que nadie vio. Se
 * pide que lo escriba, o que mande el audio de nuevo.
 *
 * Vive acá y no adentro de una plantilla porque los dos canales dicen lo mismo
 * y la guarda del redactor lo usa.
 */
export const AUDIO_SIN_TRANSCRIBIR =
  "No pudimos escuchar bien tu nota de voz. ¿Nos escribís lo que nos querías contar, o nos la mandás de nuevo?";

const NOMBRA_EL_AUDIO =
  /(?<!\p{L})(?:audios?|(?:nota|mensaje)s?\s+de\s+voz)(?!\p{L})/iu;
// Que no se escuchó, y no sólo que se nombra: «recibimos tu audio» nombra y no lo dice.
const DICE_QUE_NO_SE_ESCUCHO =
  /(?<!\p{L})no\s+(?:se\s+)?(?:(?:pudo|pudimos|pude|logramos|logré|llegamos\s+a|llegué\s+a)\s+)?(?:escuch|entend|o[ií]r|oy|oím|oí)\p{L}*/iu;
const PIDE_ESCRIBIRLO =
  /(?<!\p{L})(?:escrib\p{L}*|escrito|por\s+mensaje|(?:de|a)\s+nuevo|otra\s+vez|reenv\p{L}*|volv\p{L}*\s+a\s+(?:envi|mand|grab)\p{L}*)(?!\p{L})/iu;
// «tomamos nota» o «ya está anotado» es justo lo que no se puede afirmar de lo que nadie escuchó.
const DICE_QUE_LO_ANOTO =
  /(?<!\p{L})(?:tom(?:amos|[eé])\s+nota|anot(?:amos|[eé]|ad[oa]s?)|registr(?:amos|[eé]|ad[oa]s?)|tenemos\s+en\s+cuenta|lo\s+que\s+(?:nos\s+)?contaste)(?!\p{L})/iu;

/** Dice que no se escuchó el audio y pide escribirlo o mandarlo de nuevo, sin darlo por anotado. */
export function diceQueNoSeEscucho(texto: string): boolean {
  return (
    NOMBRA_EL_AUDIO.test(texto) &&
    DICE_QUE_NO_SE_ESCUCHO.test(texto) &&
    PIDE_ESCRIBIRLO.test(texto) &&
    !DICE_QUE_LO_ANOTO.test(texto)
  );
}
