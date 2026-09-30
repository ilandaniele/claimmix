/**
 * El enlace público del formulario web: el mismo formato que exige el CHECK de
 * `formulario_web.slug` (0044). De 4 a 40 caracteres, minúsculas, números y
 * guiones sin empezar ni terminar en guion, y que no parezca un uuid: el enlace
 * es de la aseguradora, nunca el id interno del inquilino.
 */
export const PATRON_DE_SLUG = /^[a-z0-9][a-z0-9\-]{2,38}[a-z0-9]$/u;
const PARECE_UUID = /^[0-9a-f]{8}-/;

export function slugValido(slug: string): boolean {
  return PATRON_DE_SLUG.test(slug) && !PARECE_UUID.test(slug);
}

/** El enlace de quien no elige el suyo: siempre con el formato, y nunca parece un uuid (empieza con letras). */
export function slugAlAzar(): string {
  const hexa = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0"));
  return `denuncia-${hexa.join("")}`;
}

/*
 * Lo que la página pide en cada campo, dicho una sola vez: la ruta valida con
 * estas expresiones y la página las pone en `pattern`, así el navegador frena
 * lo que el servidor rechazaría y nadie pierde su relato por un correo mal
 * escrito. La página no lleva JavaScript: un rechazo del servidor repinta el
 * formulario vacío.
 *
 * El navegador compila `pattern` con la bandera `v`: dentro de una clase, `( ) [
 * ] { } / - \ |` van escapados o el patrón se ignora en silencio (por eso los
 * `\(`, `\)` y `\-`). El test compila cada una con `v` para que no pase.
 */

/** Un correo con dominio y extremo (`ana@empresa` no sirve): sin espacios ni dos direcciones. */
export const PATRON_DE_CORREO = /^(?!\.)(?!.*\.\.)[\w'+.\-]*[\w+\-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/u;

/** Sólo dígitos y los signos de un teléfono, de 6 a 40. Es opcional: el vacío no se valida. */
export const PATRON_DE_TELEFONO = /^[\d+\(\)\s.\-]{6,40}$/u;

/** Dos caracteres a la vista, sin espacios en los extremos que el servidor recorta ni `<` `>` ni marcas invisibles. */
export const PATRON_DE_NOMBRE = /^\s*[^<>\s\p{Cc}\p{Cf}](?:[^<>\p{Cc}\p{Cf}]*[^<>\s\p{Cc}\p{Cf}])\s*$/u;
