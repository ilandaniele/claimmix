/**
 * Agrupa filas de la bandeja en las columnas del tablero de estado.
 *
 * Es la misma partición que ya usa el panel de filtros y sus contadores:
 * `ESTADOS_DE_LA_OPCION`, en `filtro-de-estado.ts`. Un caso cae en una sola
 * columna, nunca en dos, y lo que no entra en ninguna —`no_relevante`,
 * `error_core`— no se descarta en silencio: se cuenta en `fuera`.
 */

import { CLAVES_DE_ESTADO, ESTADOS_DE_LA_OPCION, type ClaveDeEstado } from "./filtro-de-estado";
import type { CaseStatus } from "@/lib/schemas/cases";

export function agruparEnColumnas<T extends { status: string }>(
  filas: readonly T[]
): { columnas: Record<ClaveDeEstado, T[]>; fuera: number } {
  const columnas = {} as Record<ClaveDeEstado, T[]>;
  for (const clave of CLAVES_DE_ESTADO) columnas[clave] = [];

  let fuera = 0;
  for (const fila of filas) {
    const clave = CLAVES_DE_ESTADO.find((c) =>
      ESTADOS_DE_LA_OPCION[c].has(fila.status as CaseStatus)
    );
    if (clave) columnas[clave].push(fila);
    else fuera++;
  }

  return { columnas, fuera };
}
