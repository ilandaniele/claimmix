/**
 * Patentes y nombres, comparados como los escribe la gente.
 *
 * Una patente se escribe `AB 123 CD`, `ab123cd` y `AB-123-CD`: es el mismo
 * auto. A diferencia de un número de póliza (ver `normalizarNumeroPoliza`),
 * una patente no tiene formas distintas que sean autos distintos, así que acá
 * el guion y el punto sí se sacan.
 */

import { normalizarNombre } from "@/core/matching/normalizar";

export function normalizarPatente(valor: string): string {
  return valor.replace(/[\s.-]+/g, "").toUpperCase();
}

function tokens(nombre: string): Set<string> {
  return new Set(normalizarNombre(nombre).split(" ").filter((t) => t.length >= 3));
}

/**
 * ¿Pueden ser la misma persona? Alcanza con que compartan una palabra de tres
 * letras o más, sin tildes ni mayúsculas: «María José Pérez» y «PEREZ MARIA».
 * Es a propósito generoso: esto marca una incompatibilidad, y ante la duda no
 * se marca.
 */
export function nombresCompatibles(a: string, b: string): boolean {
  const ta = tokens(a);
  for (const t of tokens(b)) if (ta.has(t)) return true;
  return false;
}

/**
 * ¿Es la misma persona? Más exigente: todas las palabras del nombre más corto
 * están en el otro. «Juan Pérez» no es «Carlos Pérez», aunque sean compatibles.
 */
export function mismaPersona(a: string, b: string): boolean {
  const [corto, largo] = [tokens(a), tokens(b)].sort((x, y) => x.size - y.size);
  return corto!.size > 0 && [...corto!].every((t) => largo!.has(t));
}
