/**
 * Lo que la persona acaba de escribir, y lo que dijo sin precisar.
 *
 * El ensayo del 23/09 (goteo): a «Fue un choque, ayer a la tarde» se le
 * contestó «¿Fue a la tarde, correcto?», y en la vuelta siguiente esa pregunta
 * desapareció sin respuesta y apareció «Más o menos a qué hora fue.». Un valor
 * que la persona escribió recién no se le devuelve como duda; y una franja del
 * día no es una hora: se pide una vez, con una sola forma, hasta que la dé.
 */

import { canonicalFieldKey } from "@/lib/labels/claim-fields";
import { esValorVacio } from "./valor-legible";

// Sin acentos ni signos, y un número partido con puntos, guiones o dos puntos es
// uno solo: «a las 18.30» tiene que coincidir con el `18:30` que guardó el extractor.
function plano(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/(\d)[.:\- ](?=\d)/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Una coma o un signo cortan la frase: en «No, soy Roberto Paz» el «no» es de
// otra. El punto y los dos puntos no: están en «Av. Alem», «25.888.101», «18:30».
function frases(texto: string): string[] {
  return texto.split(/[,;!?¿¡\n]+/).map(plano).filter(Boolean);
}

const NEGACIONES = new Set([
  "no", "ni", "nunca", "jamas", "tampoco",
  "not", "never", "nor", "isn", "wasn", "aren", "weren", "don", "didn", "doesn",
]);

/**
 * Si la persona acaba de escribir el valor, palabra por palabra, y no para
 * negarlo: «No, no soy Roberto Paz» no dice que sea Roberto Paz.
 *
 * Un número suelto no cuenta: ahí la duda es de qué es —DNI, póliza, teléfono—
 * y no qué escribió. De qué campo es un valor con letras lo dice haberlo
 * pedido, y eso lo mira quien llama.
 */
export function dichoRecien(valor: string, texto: string | null | undefined): boolean {
  if (!texto || esValorVacio(valor)) return false;
  const buscado = plano(valor);
  // Sobre el valor crudo: «18:30» es una hora, no un número suelto.
  if (buscado.length < 3 || /^[\d\s.\-]+$/.test(valor)) return false;
  return frases(texto).some((f) => {
    const i = ` ${f} `.indexOf(` ${buscado} `);
    return i >= 0 && !f.slice(0, i).trim().split(" ").slice(-3).some((p) => NEGACIONES.has(p));
  });
}

// Una hora dicha con palabras también es una hora: «a las seis», «al mediodía».
const HORAS_EN_PALABRAS = new Set([
  "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce",
  "mediodia", "medianoche",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "noon", "midnight",
]);

/** Una hora del siniestro que es una franja del día («a la tarde»), no una hora. */
export function esValorVago(clave: string, valor: string | null | undefined): boolean {
  if (canonicalFieldKey(clave) !== "hora_siniestro" || esValorVacio(valor)) return false;
  const v = plano(valor ?? "");
  return !/\d/.test(v) && !v.split(" ").some((p) => HORAS_EN_PALABRAS.has(p));
}

// Cerradas a propósito, y las dos lenguas avanzan juntas: una palabra de afuera
// es que la frase habla de otra cosa.
const FRANJAS = new Set([
  "manana", "tarde", "tardecita", "noche", "nochecita", "anoche", "madrugada",
  "atardecer", "anochecer", "amanecer",
  "morning", "afternoon", "evening", "night", "dusk", "nightfall", "dawn", "sunset", "sunrise",
]);
const NO_SABE = new Set([
  "acuerdo", "recuerdo", "idea", "se", "sabria", "seguro", "certeza", "olvide", "olvido",
  "know", "remember", "recall", "sure", "certain", "clue", "forget", "forgot", "dunno",
]);
const RELLENO = new Set([
  "fue", "era", "habra", "sido", "seria", "creo", "que", "yo", "a", "al", "la", "las", "el", "lo",
  "por", "de", "del", "en", "con", "durante", "eso", "esa", "mas", "o", "menos", "bien", "me",
  "hora", "exacta", "exactamente", "ayer", "hoy", "pero", "igual", "verdad", "ya", "tengo",
  "decirte", "decir", "tipo", "como", "media", "temprano", "capaz", "quizas", "quiza", "tal", "vez",
  "supongo", "calculo", "diria",
  "it", "was", "would", "be", "in", "the", "at", "for", "during", "that", "around", "about", "i",
  "m", "t", "d", "have", "can", "say", "think", "maybe", "perhaps", "probably", "guess", "suppose",
  "but", "really", "honestly", "exact", "exactly", "time", "yesterday", "today", "last", "sometime",
  "like", "mid", "early", "late",
]);

/**
 * Si contestó «¿más o menos a qué hora fue?» sin dar una hora: con la franja
 * sola («fue a la tarde») o con que no sabe («no me acuerdo», «I don't know»).
 *
 * Frase por frase, y cada una entera: «esta tarde te mando las fotos» no habla
 * de la hora del choque, ni «no me acuerdo el número de póliza». Sin esto, quien
 * no sabe la hora quedaba con la pregunta abierta para siempre.
 */
export function contestaSinHora(texto: string | null | undefined): boolean {
  return frases(texto ?? "").some((f) => {
    const p = f.split(" ");
    const tiene = (s: Set<string>) => p.some((w) => s.has(w));
    return (
      p.every((w) => RELLENO.has(w) || NEGACIONES.has(w) || FRANJAS.has(w) || NO_SABE.has(w)) &&
      (tiene(NO_SABE) || (tiene(FRANJAS) && !tiene(NEGACIONES)))
    );
  });
}

// «¿…, es correcto?», «¿Es así?» y «confirmame que…» proponen un valor;
// «¿me confirmás tu póliza?» pide uno.
const CONFIRMA = /\b(?:correct[oa]|es asi|verdad)\b|\bconfirm\w*\s+(?:que|si)\b/;
// «Entendemos que fue en Alem. ¿Correcto?»: la pregunta es la oración de antes.
const SOLO_CONFIRMA = /^(?:es )?(?:correct[oa]|asi|verdad)$/;

function confirmaciones(mensaje: string): string[] {
  const oraciones: string[] = [];
  for (const o of mensaje.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)) {
    if (oraciones.length > 0 && SOLO_CONFIRMA.test(plano(o))) oraciones[oraciones.length - 1] += ` ${o}`;
    else oraciones.push(o);
  }
  return oraciones.filter((o) => o.includes("?") && CONFIRMA.test(plano(o))).map(plano);
}

// Lo que se copia tal cual: un número de tres cifras o más —póliza, patente,
// hora, altura— o dos palabras seguidas con mayúscula —un nombre, un lugar—.
// Una sola no: el nombre de pila va en el saludo.
function copiables(texto: string): string[] {
  const numeros = plano(texto).split(" ").filter((p) => p.length >= 3 && /\d/.test(p));
  const nombres = [...texto.matchAll(/(?=(\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+))/gu)].map((m) => plano(m[1]));
  return [...numeros, ...nombres];
}

/**
 * Si el mensaje le pregunta si es correcto algo que la persona acaba de
 * escribir y que no está entre `conocidos`, lo que el orquestador eligió
 * confirmar.
 *
 * Goteo, 23/09: a «La póliza es POL-3311-B» se le contestó «Entendemos que tu
 * póliza es POL-3311-B, ¿es correcto?». La póliza la había encontrado el
 * agente y no estaba en la lista; el redactor la sacó del último mensaje.
 */
export function confirmaLoQueEscribio(
  mensaje: string,
  texto: string | null | undefined,
  conocidos: string[]
): boolean {
  if (!texto) return false;
  const tenidos = conocidos.map(plano);
  const libres = copiables(texto).filter(
    (d) =>
      !tenidos.some((k) => (/\d/.test(d) ? k.replace(/ /g, "").includes(d) : ` ${k} `.includes(` ${d} `)))
  );
  return (
    libres.length > 0 &&
    confirmaciones(mensaje).some((o) => libres.some((d) => ` ${o} `.includes(` ${d} `)))
  );
}
