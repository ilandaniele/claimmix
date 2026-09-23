/**
 * La pregunta del último mensaje, para cuando el agente no deliberó.
 *
 * Sin plan —un 429 o un timeout del proveedor— nadie decía «nos preguntó
 * algo», y con el pedido ya en pie el caso quedaba mudo frente a un «¿cuánto
 * suele tardar esto?». Sólo se usa sin plan: con plan, manda el plan.
 */

import { stripQuotedReply } from "@/core/email/conversation";

const URL = /https?:\/\/\S+/gi;
// Después del signo, cualquier cosa menos una letra o un número: un emoji, una
// coma, «...», un paréntesis. La letra pegada es la de un `?utm=` sin http.
const TERMINA_EN_PREGUNTA = /[^.!?\n]*\?+(?![\p{L}\p{N}])/gu;
// La búsqueda es cuadrática en un tramo sin puntuación, y el cuerpo de un mail
// no tiene tope: se mira sólo lo que el extractor lee de cada mensaje.
const MAX_ENTRADA = 4_000;
const MAX_LARGO = 400;
// Lo que viene debajo no lo escribió para nosotros: la firma («--») y la cita
// de Outlook y Hotmail, que va sin «>» (una raya de guiones bajos, o «De:»
// seguido de «Enviado:»). Una firma con «?» volvía pregunta cada mensaje de esa
// persona. No va en `stripQuotedReply` porque el extractor necesita las dos: la
// firma trae nombre y teléfono, y un reenvío desde Outlook trae el siniestro
// debajo de ese encabezado.
const FIRMA_O_CITA =
  /^[ \t]*(?:--[ \t]*$|_{8,}[ \t]*$|\*?(?:de|from):\*?[^\n]*\n[ \t]*\*?(?:enviado(?: el)?|sent|fecha|date):)/im;
// El pie ecológico que el servidor de la empresa pega en cada mail, sin firma.
const PIE_DE_IMPRESION =
  /(?:imprimir|print)\s+(?:este|el presente|this)\s+(?:correo|e-?mail|mail|mensaje|message)/i;

const esPregunta = (f: string) =>
  (f.match(/\p{L}/gu) ?? []).length >= 4 && !PIE_DE_IMPRESION.test(f);

// Sólo cuentan los signos: un falso positivo reenvía el pedido que ya estaba en
// pie con la frase honesta; un falso negativo deja las cosas como estaban.
export function laPreguntaDelMensaje(texto?: string | null): string | null {
  const propio = stripQuotedReply((texto ?? "").slice(0, MAX_ENTRADA));
  const corte = propio.search(FIRMA_O_CITA);
  const limpio = (corte >= 0 ? propio.slice(0, corte) : propio).replace(URL, " ");
  // El «¿» sin cierre se busca después del último «?»: si no, un «¿si?» corto
  // lo tapaba o lo arrastraba.
  const resto = limpio.slice(limpio.lastIndexOf("?") + 1);
  const abierta = resto.includes("¿") ? resto.slice(resto.indexOf("¿")).split(/[.!\n]/)[0] : "";
  const pregunta = [...(limpio.match(TERMINA_EN_PREGUNTA) ?? []), abierta]
    .map((f) => f.trim())
    .filter(esPregunta)
    .join(" ")
    .slice(0, MAX_LARGO);
  return pregunta || null;
}
