/**
 * Un entero leído del entorno, con piso y techo.
 *
 * Lo que no es un entero escrito con dígitos, o cae fuera de [min, max], toma
 * el valor por omisión: una variable vacía, mal escrita o con un cero de más
 * nunca vuelve "sin límite" un tope que cuesta plata.
 */
export function entero(nombre: string, porDefecto: number, min: number, max: number): number {
  return enteroDe(process.env[nombre], min, max) ?? porDefecto;
}

/** El entero escrito, o null si no es un entero con dígitos dentro de [min, max]. */
export function enteroDe(crudo: string | undefined, min: number, max: number): number | null {
  const t = crudo?.trim();
  if (!t || !/^-?\d+$/.test(t)) return null;
  const valor = Number(t);
  return Number.isSafeInteger(valor) && valor >= min && valor <= max ? valor : null;
}
