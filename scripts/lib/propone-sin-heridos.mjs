/**
 * Si una respuesta le propone a la persona que no hubo heridos.
 *
 * El ensayo del 23/09 mandó «• ¿Hubo personas lastimadas?: no» a quien nunca
 * habló de heridos, y nadie lo marcó: pasaba todas las afirmaciones. El ensayo
 * usa esto sobre el texto legible y en minúsculas, y falla cuando la persona no
 * nombró heridos en ningún turno.
 *
 * Una pregunta abierta no cuenta: «¿Hubo personas lastimadas?», «¿Hubo o no
 * hubo…?», «Contanos si no hubo heridos».
 */

const PROPUESTAS = [
  // «No hubo personas lastimadas, ¿es correcto?», «sin heridos»; no «si no hubo…» ni «o no hubo…».
  /(?<!\bsi |\bo )\bno hubo (?:personas )?(?:lastimad|herid)/i,
  /(?<!\bsi |\bo )\bsin (?:personas )?(?:lastimad|herid)/i,
  /\bnadie (?:result[oó] |sali[oó] |se )?(?:lastim|herid)/i,
  // La lista: «¿Hubo personas lastimadas?: no», «¿No hubo personas lastimadas? no».
  /(?:lastimad|herid)\w*\??[ \t]*:?[ \t]*no[ \t.!]*$/im,
  // Los pisos: «Si hubo personas lastimadas: entendimos "no"».
  /(?:lastimad|herid)\w*[^\n]*entendimos[ \t]*[«"]?no\b/i,
  // El de confirmación, en dos renglones: la etiqueta y después el valor.
  /(?:lastimad|herid)\w*[^\n]*\n\s*(?:no[ \t.]*$|entendimos[ \t]*[«"]?no\b|obtuvimos el siguiente dato de tu correo:[ \t]*no\b)/im,
];

/** Si el texto le propone «no hubo heridos» en vez de preguntarlo abierto. */
export function proponeSinHeridos(texto) {
  return PROPUESTAS.some((re) => re.test(texto));
}
