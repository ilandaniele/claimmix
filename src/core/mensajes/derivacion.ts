/**
 * La derivación cuando alguien contó que hay heridos.
 *
 * El ensayo del 23/09 (incendio-grave) le contestó a quien tenía a su señora
 * internada con quemaduras un «Recibimos tu denuncia. Ya la derivamos a un
 * especialista…» que no decía nada de eso: correcto y de trámite. La frase la
 * usan los dos pisos y el redactor; los predicados, la guarda del redactor.
 */

/** Sin diagnóstico, sin promesa, sin pedido y sin repetir lo que contó. */
export const CUIDADO = "Lamentamos mucho lo que están pasando.";

// «Lamentablemente» no es cuidado: es cómo empieza una mala noticia.
const DICE_CUIDADO = /\blament(?:amos|o)\b|\bsentimos mucho\b/i;
const PIDE_DATOS = /necesitamos que nos|envianos|mandanos/i;
// El redactor lee «mi señora está internada con quemaduras» para el tono, y con
// la consigna de cuidado lo más fácil es devolverlo: «que se recupere pronto de
// las quemaduras». Eso repite lo médico y pronostica. «Salud» entera: «Saludos» no.
// «Esté bien» con tilde: «este bien» es el bien asegurado.
const HABLA_DE_LA_SALUD =
  /\b(?:internad|quemadur|herid|lastim|lesi[oó]n|hospital|sanatorio|cl[ií]nica|recuper|mejor(?:[ií]a|en?\b)|diagn[oó]stic|pron[oó]stic|salud\b)|\b(?:estén?|se encuentren?|se sientan?|se pongan?)\s+(?:bien|mejor)\b/i;

/** Si el texto trae una frase de cuidado, la nuestra o la del redactor. */
export function diceCuidado(texto: string): boolean {
  return DICE_CUIDADO.test(texto);
}

/** Si el texto le pide algo a la persona: en una derivación se contradice. */
export function pideDatos(texto: string): boolean {
  return PIDE_DATOS.test(texto);
}

/** Si el texto nombra heridas, internación o la salud de alguien. */
export function hablaDeLaSalud(texto: string): boolean {
  return HABLA_DE_LA_SALUD.test(texto);
}
