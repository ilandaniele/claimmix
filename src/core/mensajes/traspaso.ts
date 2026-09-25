/**
 * El traspaso: la carga de datos termina acá y sigue una persona.
 *
 * El cierre decía «un analista la va a revisar y te contactamos si hiciera
 * falta», y la derivación, que se comunica un especialista. Ninguno decía que
 * por este chat o este correo ya no lee nadie ni que la persona que sigue
 * escribe desde otro número o dirección: quien contestaba acá hablaba solo, y
 * al que le escribía el equipo no lo reconocía. Lo usan los pisos de los dos
 * canales y el redactor; el predicado, la guarda del redactor y el ensayo.
 */

export const AVISO_DE_TRASPASO =
  "Con esto cerramos la carga de datos por este medio. Una persona del equipo te va a escribir desde otro número o desde otra dirección de correo.";

/** El pie de los dos mails que cierran: una respuesta a ese correo no se pierde. */
export const SI_RESPONDES_EL_CORREO = "Si respondés este correo, lo lee una persona del equipo.";

/**
 * El pie de WhatsApp: un mensaje después del traspaso se suma al caso y queda
 * en «Para responder» (`ESTADOS_WHATSAPP_QUE_SUMAN_MENSAJES`), y «cerramos por
 * este medio» tiene que decir qué pasa si igual escribe.
 */
export const SI_VOLVES_A_ESCRIBIR = "Si nos volvés a escribir a este número, lo lee una persona del equipo.";

/**
 * La derivación que sale en la misma vuelta que un pedido de confirmación: esa
 * respuesta ya no la lee nadie, y sin esto la persona no sabe si contestar.
 */
export const NO_HACE_FALTA_CONTESTAR = "No hace falta que contestes lo que te preguntamos recién.";

// Las dos mitades por separado: el redactor las dice con otras palabras, y sin
// cualquiera de las dos el aviso no sirve. «cierr» aparte porque «se cierra» es
// lo que le sugiere el brief y no empieza con «cerr».
const CIERRA =
  /\b(?:cerr|cierr|termin|finaliz|conclu)\w*\b[^.!?\n]{0,80}?\b(?:carga|por (?:este medio|ac[aá]|este (?:canal|chat|correo|mail)))|\bcarga(?: de datos)?\b[^.!?\n]{0,40}\b(?:termin|cerr|cierr|finaliz)/i;
const OTRO_MEDIO = /\botr[oa]\s+(?:n[uú]mero|direcci[oó]n|correo|mail|casilla|tel[eé]fono)/i;

/** Si el texto dice que la carga termina acá y que sigue alguien por otro medio. */
export function mencionaElTraspaso(texto: string): boolean {
  return CIERRA.test(texto) && OTRO_MEDIO.test(texto);
}
