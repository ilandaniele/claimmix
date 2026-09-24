/**
 * Si una derivación le pide algo a la persona, sobre el texto legible y en minúsculas.
 *
 * Más ancho que `pideDatos`, la guarda del redactor, a propósito: lo que la
 * guarda rechaza nunca sale, así que el ensayo con el mismo predicado sólo
 * marcaría un piso que pide. Esto marca los pedidos que la guarda deja pasar
 * —«contanos», «te pedimos», «¿podés mandarnos…?»— en lo que el redactor
 * escribió de verdad. «Podés responder a este correo» es el ofrecimiento del
 * piso del mail, no un pedido.
 */

// «Si tenés más información, podés enviarla respondiendo este correo» es el
// ofrecimiento del piso dicho de otra forma: depende de que haya algo más.
const OFRECE = String.raw`\bsi (?:ten[eé]s|quer[eé]s (?:agregar|sumar)) (?:m[aá]s |alguna |otra )?(?:informaci[oó]n|novedad|algo|dato)[^.?!\n]*`;

const PEDIDOS = [
  /[¿?]/,
  /\b(?:mand|envi|pas|cont|indic|confirm|adjunt|dej)a(?:nos|me)\b/,
  /\bdecinos\b/,
  /(?<!\bno )\bte pedimos\b|(?<!\bno )\bpedimos que\b/,
  /(?<!\bno )\bnecesitamos\b/,
  new RegExp(
    String.raw`(?<!${OFRECE})\bpod(?:[eé]s|r[ií]as|r[aá]s)\s+(?:mandar|enviar|pasar|contar|decir|indicar|adjuntar|confirmar)`
  ),
];

/** Si el texto pide algo: una pregunta, un dato, un archivo. */
export function pideAlgo(texto) {
  return PEDIDOS.some((re) => re.test(texto));
}
