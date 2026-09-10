/**
 * El mensaje como lo leería una persona.
 *
 * El correo sale como HTML, y un transcripto de ensayo lleno de estilos en
 * línea es un transcripto que nadie lee — lo que echa a perder la mitad del
 * punto, porque alguien mirando la salida por encima es cómo se nota una
 * respuesta que pasa todas las afirmaciones y suena mal igual.
 *
 * Vivía adentro de `rehearse-conversations.mts`, que es un script de
 * top-level await: importarlo lo CORRE, así que no había forma de probarlo.
 * Se cambió cuatro veces en un día y cada vez se verificó a mano, en un
 * archivo del directorio temporal que ya no existe. Acá tiene su test.
 *
 * ── Lo que este archivo NO es ───────────────────────────────────────────────
 *
 * Un saneador. La salida va a `console.log` y a un `.toLowerCase()` para buscar
 * una frase; no hay nada que renderice HTML. Lo que se cuida es que el
 * transcripto no TAPE: que un `<` que escribió un desconocido y el escape
 * convirtió bien no se lea igual de tranquilizador que uno mal escapado.
 */

/**
 * Las entidades se decodifican ANTES de sacar las etiquetas, no después.
 *
 * Estaban al final, y `&lt;script&gt;` atravesaba entero el borrado de
 * etiquetas —no hay ninguna que borrar— y recién ahí se convertía en
 * `<script>`. El paso que limpia corría antes que el paso que ensucia.
 *
 * `&amp;` va última para que `&amp;lt;` termine en `&lt;` y no en `<`: eso es
 * un `<` que alguien escribió y el escape convirtió bien, y mostrarlo como `<`
 * lo hace indistinguible de uno que se escapó mal.
 */
export function sinEntidades(texto) {
  return texto
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Una pasada de todo lo que hay que sacar o traducir. Ver `sinEtiquetas`. */
export function unaPasada(texto) {
  return texto
    .replace(/<head[\s\S]*?<\/head[^>]*>/gi, "")
    .replace(/<(script|style)[\s\S]*?<\/\1[^>]*>/gi, "")
    .replace(/<\/(p|div|h1|h2|h3|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
}

/**
 * Sacar etiquetas de a una pasada no alcanza.
 *
 * Tres formas del mismo error, las tres reales acá:
 *
 *   · El cierre acepta espacio, salto de línea y atributos antes del `>`, así
 *     que `</script >` no matcheaba y el cuerpo del script terminaba adentro
 *     del transcripto que lee una persona.
 *   · Borrar `<…>` una vez deja `<<a>script>` convertido en `<script>`: la
 *     pasada CONSTRUYE la etiqueta que venía a sacar.
 *   · Lo mismo vale para el borrado de `<script>…</script>`, y por eso el bucle
 *     envuelve la pasada ENTERA y no sólo el `<[^>]+>` del final.
 *
 * Sin tope, y eso NO es un bucle abierto sobre texto que escribió otro: cada
 * pasada es estrictamente más corta o idéntica —los seis reemplazos o borran, o
 * cambian una secuencia por una más corta— así que un largo que no puede crecer
 * y que corta al repetirse termina siempre.
 *
 * Un tope parecía prudente y era peor: salir en la vuelta ocho deja el texto a
 * medio limpiar y nadie se entera.
 */
export function sinEtiquetas(texto) {
  let antes = texto;
  for (;;) {
    const despues = unaPasada(antes);
    if (despues === antes) return despues;
    antes = despues;
  }
}

/** El cuerpo de un mensaje, listo para imprimir en el transcripto. */
export function readable(body) {
  if (!/<[a-z!]/i.test(body) && !/&[a-z#]/i.test(body)) return body;
  return sinEtiquetas(sinEntidades(body))
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, all) => line.length > 0 || (i > 0 && all[i - 1].length > 0))
    .join("\n")
    .trim();
}
