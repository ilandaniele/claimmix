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
// «no se escuchó», «no la pudimos escuchar», «no te entendimos», «no se te escucha», «no se llegó a escuchar».
const NO_SE_ESCUCHO = String.raw`(?<!\p{L})no\s+(?:(?:se\s+)?(?:te|l[oa]s?)\s+|se\s+)?(?:(?:pud(?:o|e|imos)|logr(?:amos|é)|consegu(?:imos|í)|lleg(?:amos|ué|ó)\s+a)\s+)?(?:escuch|enti?end|o[iíy])\p{L}*`;
// «tu último audio» es cuál, no qué pedazo.
const PEDAZO = String.raw`partes?|pedazos?|mitad|resto|principio|comienzo|[uú]ltim[oa](?!\s+(?:audio|nota|mensaje))|tramos?`;
// Que no se escuchó, y no sólo que se nombra: «recibimos tu audio» nombra y no lo dice.
const DICE_QUE_NO_SE_ESCUCHO = new RegExp(NO_SE_ESCUCHO, "iu");
// Que no se escuchó una parte («una parte no se entendió», «no pudimos escucharlo todo»): el resto quedaría por escuchado.
// «todo» va pegado al verbo, porque «se corta todo el tiempo» no habla de una parte, y «algo de ruido y» no es un pedazo.
const NO_SE_ESCUCHO_UNA_PARTE = new RegExp(
  String.raw`(?<!\p{L})(?:${PEDAZO}|algo|el\s+final)(?:\s+del?(?:\s+(?!y(?!\p{L}))\p{L}+){1,4})?\s+${NO_SE_ESCUCHO}` +
    String.raw`|${NO_SE_ESCUCHO}(?:\s+bien)?\s+tod[oa]s?(?!\p{L})` +
    String.raw`|${NO_SE_ESCUCHO}(?:\s+\p{L}+){0,4}?\s+(?:del\s+todo|complet[oa]s?|enter[oa]s?|final|${PEDAZO})(?!\p{L})` +
    String.raw`|(?<!\p{L})(?:a\s+medias|en\s+partes?)(?!\p{L})`,
  "iu"
);
// Un pedido a la persona: «escribinos», «mandala», «contás».
const PEDIDO = String.raw`(?:escrib[ií]|mand[aá]|cont[aá]|pas[aá]|grab[aá])(?:s|n[oa]s|l[oa]s?)?`;
// Lo que niega el verbo que sigue o lo deja para después: «no la escuchamos», «mandala así la escuchamos»,
// «escribinos y lo sumamos», «escribinos lo que nos dijiste».
const SIN_AFIRMARLO = String.raw`(?<!(?<!\p{L})(?:no|así|apenas|${PEDIDO}(?:(?:\s+\p{L}+){0,4}\s+y)?)\s+(?:\p{L}+\s+){0,2})(?<!\p{L})`;
// Que se escuchó, se revisó o se sumó al reclamo.
const DICE_QUE_SE_ESCUCHO = new RegExp(
  String.raw`${SIN_AFIRMARLO}(?:escuch(?:amos|é|ad[oa])|o[ií](?:mos)?|entend(?:imos|í|id[oa])|revis(?:amos|é|ad[oa])|pud(?:imos|e)\s+(?:escuch|entend|o[ií]r)\p{L}*|se\s+(?:escuch|entend)i?ó\s+bien|(?:sum|agreg|incorpor)(?:amos|é|ad[oa]s?))(?!\p{L})`,
  "iu"
);
const PIDE_ESCRIBIRLO =
  /(?<!\p{L})(?:escrib\p{L}*|escrito|por\s+(?:mensaje|texto|ac[aá])|en\s+un\s+mensaje|(?:de|a)\s+nuevo|de\s+vuelta|otra\s+vez|reenv\p{L}*|volv\p{L}*\s+a\s+(?:envi|mand|grab)\p{L}*|(?:mand|envi|grab)\p{L}*\s+otr[oa]s?)(?!\p{L})/iu;
// «tomamos nota» o «ya está anotado» es justo lo que no se puede afirmar de lo que nadie escuchó.
const DICE_QUE_LO_ANOTO = new RegExp(
  String.raw`${SIN_AFIRMARLO}(?:tom(?:amos|[eé])\s+nota|anot(?:amos|[eé]|ad[oa]s?)|registr(?:amos|[eé]|ad[oa]s?)|tenemos\s+en\s+cuenta|lo\s+que\s+(?:nos\s+)?(?:contaste|dijiste))(?!\p{L})`,
  "iu"
);

/** Dice que no se escuchó el audio y pide escribirlo o mandarlo de nuevo, sin darlo por escuchado ni anotado, ni en parte. */
export function diceQueNoSeEscucho(texto: string): boolean {
  return (
    NOMBRA_EL_AUDIO.test(texto) &&
    DICE_QUE_NO_SE_ESCUCHO.test(texto) &&
    PIDE_ESCRIBIRLO.test(texto) &&
    !NO_SE_ESCUCHO_UNA_PARTE.test(texto) &&
    !DICE_QUE_SE_ESCUCHO.test(texto) &&
    !DICE_QUE_LO_ANOTO.test(texto)
  );
}
