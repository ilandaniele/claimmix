/**
 * La bitácora del flujo de prueba: anotar en un archivo y volver a leerlo.
 *
 * Está aparte de los pasos por una razón concreta del compilador de flujos. Un
 * `import "node:fs"` en el mismo archivo que un `"use workflow"` hace fallar la
 * compilación, incluso si el uso está adentro de una función marcada
 * `"use step"` — el chequeo mira el grafo del módulo, no dónde cae la llamada.
 *
 * Y tiene sentido más allá del compilador: el cuerpo del flujo se vuelve a
 * ejecutar entero en cada retoma, reproduciendo lo ya hecho. Nada de lo que
 * haya en ese grafo puede tener efectos.
 */
import { appendFileSync, readFileSync, rmSync } from "node:fs";

/** Los pasos que quedaron anotados, en orden. */
export function leerBitacora(archivo: string): string[] {
  try {
    return readFileSync(archivo, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function anotar(archivo: string, paso: string): void {
  appendFileSync(archivo, `${paso}\n`);
}

export function borrarBitacora(archivo: string): void {
  try {
    rmSync(archivo);
  } catch {
    // No existía. Es el caso normal antes del primer test.
  }
}
