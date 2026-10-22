/**
 * El texto de la caja de búsqueda, recortado.
 *
 * Vive en su propio módulo, sin dependencias, porque lo leen dos lados: la
 * página de servidor, que lo manda a la consulta, y el sondeo en vivo del
 * cliente (`useCasesRealtime`), que tiene que pedir lo mismo que la página. Si
 * viviera en `page.tsx`, el cliente arrastraría todo el servidor para importarlo.
 *
 * Ochenta caracteres alcanza y sobra para un nombre, una póliza o un número
 * de caso; más que eso es un enlace armado a mano, no algo que alguien tipeó
 * en el campo. Vacío, sólo espacios o menos de tres caracteres da
 * `undefined`, igual que `valores()` con el resto de los filtros.
 *
 * El piso de tres espeja el `q.min(3)` de `CaseQuerySchema` (ver
 * src/lib/schemas/cases.ts): con uno o dos caracteres pg_trgm no tiene un
 * grupo de tres para buscar y el planificador descarta el índice, así que
 * `listCases`/`contarPorEstado` recorrerían la tabla entera del inquilino en
 * cada pausa de tipeo. `CampoDeBusqueda` debounca por TIEMPO, no por
 * longitud, así que esos estados intermedios de uno o dos caracteres pasan
 * de verdad. Y /api/cases contesta 400 por debajo de ese piso.
 */
export function normalizarBusqueda(raw: string | string[] | undefined): string | undefined {
  const valor = Array.isArray(raw) ? raw[0] : raw;
  const recortado = valor?.trim().slice(0, 80);
  return recortado && recortado.length >= 3 ? recortado : undefined;
}
