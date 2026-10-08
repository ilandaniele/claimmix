/**
 * Un entero leído del entorno, con piso y techo.
 *
 * Lo que no es un entero escrito con dígitos, o cae fuera de [min, max], toma
 * el valor por omisión: una variable vacía, mal escrita o con un cero de más
 * nunca vuelve "sin límite" un tope que cuesta plata.
 */
export function entero(nombre: string, porDefecto: number, min: number, max: number): number {
  const crudo = process.env[nombre]?.trim();
  if (!crudo || !/^-?\d+$/.test(crudo)) return porDefecto;
  const valor = Number(crudo);
  return Number.isSafeInteger(valor) && valor >= min && valor <= max ? valor : porDefecto;
}
