/**
 * ¿El valor que el agente dice haber encontrado salió de verdad de una búsqueda?
 *
 * `plan.resolved` escribe un valor en la denuncia con confianza 0.95 y cierra el
 * pedido de ese campo. La única condición que le ponía `validate` era que el
 * plan hubiera llamado a ALGUNA herramienta — no que el valor viniera de alguna.
 * Comprobado llamándola:
 *
 *   herramienta: polizas_por_dni → { encontradas: 0 }
 *   resolved:    policy_number = "POL-INVENTADA-9999"
 *   validate():  ACEPTADO
 *
 * O sea: la consulta no encontró nada, el modelo escribió un número de póliza de
 * la nada, y se guardaba con la confianza más alta que maneja el sistema. El
 * propio comentario del campo advierte que «un modelo que puede escribir valores
 * de memoria es un modelo que puede inventar un número de póliza», y la guarda
 * que lo impedía no existía.
 *
 * Esto es la otra mitad del arreglo de los documentos: allá se descartaba lo que
 * ninguna búsqueda puede producir (un archivo); acá se descarta lo que ESTA
 * búsqueda no produjo.
 */

/** Sólo letras y números, en minúscula. */
function soloAlfanumerico(texto: string): string {
  return texto.toLowerCase().replace(/[^a-z0-9áéíóúüñ]/g, "");
}

/**
 * ¿Aparece este valor en lo que devolvieron las consultas?
 *
 * Se compara sin puntuación ni mayúsculas, porque el modelo reformatea: la
 * consulta devuelve `"numero":"POL-8812-R"` y el plan puede escribir
 * `POL 8812 R`. Son el mismo dato y exigir el calco los separaría.
 *
 * @param valor       Lo que el agente quiere escribir en la denuncia.
 * @param resultados  El texto crudo de cada consulta que hizo, en orden.
 */
export function estaRespaldado(
  valor: string,
  resultados: readonly string[]
): boolean {
  const buscado = soloAlfanumerico(valor);

  /*
   * Un valor vacío o de un solo carácter no se puede respaldar.
   *
   * Y tampoco hace falta: `soloAlfanumerico("—")` es la cadena vacía, y la
   * cadena vacía está contenida en CUALQUIER texto. Sin esta guarda, todo lo
   * que no tuviera letras ni números pasaría siempre.
   */
  if (buscado.length < 2) return false;

  return resultados.some((r) => soloAlfanumerico(r).includes(buscado));
}

/**
 * Separa lo que se puede escribir de lo que no.
 *
 * Devuelve las dos listas en vez de una: la que se descarta hace falta para
 * poder decirlo en el log. Un descarte silencioso deja el mismo agujero de
 * antes — el pedido sigue abierto y nadie sabe que el agente creyó haberlo
 * cerrado.
 */
export function separarPorRespaldo<T extends { value: string }>(
  resueltos: readonly T[],
  resultados: readonly string[]
): { respaldados: T[]; sinRespaldo: T[] } {
  const respaldados: T[] = [];
  const sinRespaldo: T[] = [];

  for (const r of resueltos) {
    if (estaRespaldado(r.value, resultados)) respaldados.push(r);
    else sinRespaldo.push(r);
  }

  return { respaldados, sinRespaldo };
}
