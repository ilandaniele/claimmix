/**
 * El valor de `pattern` de un `<input>` a partir de la expresión que ya valida
 * el servidor: la misma, sin las anclas (el navegador la ancla solo). Así
 * el formulario y la ruta no pueden desparejarse.
 */
export const patronHtml = (expresion: RegExp): string => expresion.source.replace(/^\^/, "").replace(/\$$/, "");
