/**
 * La cookie que recuerda si la barra lateral está contraída a íconos.
 *
 * Sin código de servidor: la escribe el navegador al apretar el botón y la lee
 * el layout en el servidor, así la primera pintura ya sale con el ancho
 * correcto y la barra no parpadea al hidratar.
 */
export const BARRA_COOKIE = "barra_contraida";

/** Un año, mismo formato que la cookie del idioma. */
export function cookieDeLaBarra(contraida: boolean): string {
  return `${BARRA_COOKIE}=${contraida ? "1" : "0"}; path=/; max-age=31536000; SameSite=Lax`;
}
