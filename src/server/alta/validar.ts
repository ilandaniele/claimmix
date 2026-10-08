/**
 * Lo que se le pide a quien crea su espacio: el nombre de la empresa y el
 * número de WhatsApp. Puro, sin entorno ni base.
 *
 * Las reglas de la empresa son las mismas que revisa `claimmix_crear_inquilino`
 * (0048): la función es la que manda, esto sólo evita el viaje a la base y
 * deja que el formulario diga «revisá los datos» sin crear nada.
 */

export const EMPRESA_MINIMA = 2;
export const EMPRESA_MAXIMA = 80;

/** Un número E.164: «+», un dígito que no es cero y entre 7 y 14 más. */
const E164 = /^\+[1-9][0-9]{7,14}$/;
/** Los de control de C0 y C1 y los separadores de línea y de párrafo, que la base también rechaza. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Una URL o una dirección de correo pegada donde va un nombre. */
const ENLACE_O_CORREO = /(:\/\/|www\.|@)/i;

/** Los motivos con los que /alta vuelve a mostrarse (`?e=`): lista cerrada, cada uno con su texto. */
export const ERRORES_DE_ALTA = ["datos", "cerrada", "intentos", "falla"] as const;
export type ErrorDeAlta = (typeof ERRORES_DE_ALTA)[number];

export type ResultadoDeEmpresa = { ok: true; empresa: string } | { ok: false };

/** El nombre ya recortado, o `ok: false`. Cuenta por caracteres, como `char_length`. */
export function validarEmpresa(crudo: unknown): ResultadoDeEmpresa {
  if (typeof crudo !== "string") return { ok: false };
  const empresa = crudo.trim();
  const largo = [...empresa].length;
  if (largo < EMPRESA_MINIMA || largo > EMPRESA_MAXIMA) return { ok: false };
  if (CONTROL.test(empresa) || ENLACE_O_CORREO.test(empresa)) return { ok: false };
  return { ok: true, empresa };
}

/**
 * «+54 9 (291) 642-6930» y «0054 9 291 642 6930» dan «+5492916426930». Null si no
 * queda un E.164: sin prefijo de país no se adivina ninguno.
 */
export function normalizarE164(crudo: unknown): string | null {
  if (typeof crudo !== "string") return null;
  const limpio = crudo.replace(/[\s\-()]/g, "");
  const conMas = limpio.startsWith("00") ? `+${limpio.slice(2)}` : limpio;
  return E164.test(conMas) ? conMas : null;
}

/** El mismo número sin el 9 que WhatsApp antepone a los celulares de Argentina. */
function sinNueveArgentino(e164: string): string {
  return e164.startsWith("+549") ? `+54${e164.slice(4)}` : e164;
}

/** ¿Es el mismo número? «+549…» y «+54…» lo son. Un número ilegible no es igual a nada. */
export function mismoNumero(a: unknown, b: unknown): boolean {
  const x = normalizarE164(a);
  const y = normalizarE164(b);
  return x !== null && y !== null && sinNueveArgentino(x) === sinNueveArgentino(y);
}
