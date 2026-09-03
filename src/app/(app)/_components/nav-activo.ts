/**
 * Qué ítem de la barra se resalta.
 *
 * Antes cada ítem se decidía solo, mirando únicamente el `pathname`. Eso
 * alcanzaba mientras cada ítem fuera una ruta distinta. «Escalados» era
 * `/escalados`: una página de nueve líneas que hacía `redirect` a
 * `/bandeja?status=escalado`. Un click, dos viajes al servidor — y en un
 * enlace lento, el doble de espera para llegar a una pantalla que ya existía.
 *
 * Ahora «Escalados» apunta directo a la bandeja filtrada. Pero entonces dos
 * ítems comparten `pathname`, y decidir por `pathname` resaltaba «Bandeja» en
 * los dos casos y «Escalados» en ninguno. Por eso la decisión sube a la LISTA:
 * de todos los ítems, se resalta uno solo, y gana el más específico.
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 *
 * Un ítem «calza» si su camino es el actual o un prefijo de él por `/`. Entre
 * los que calzan:
 *
 *   1. Si alguno trae query y TODOS sus pares están en la URL actual, ese.
 *      (`/bandeja?status=escalado` sobre `/bandeja?status=escalado&type=choque`.)
 *   2. Si no, el que calza sin query.
 *      (`/bandeja` sobre `/bandeja?type=choque`: un filtro cualquiera sigue
 *      siendo la bandeja; sólo `status=escalado` es «Escalados».)
 *
 * Sin `"use client"` a propósito: es una función pura y la puede importar
 * cualquiera. Un valor exportado desde un módulo de cliente le llega a un
 * componente de servidor como referencia, no como valor.
 */

function partir(href: string): { camino: string; query: URLSearchParams } {
  const i = href.indexOf("?");
  return i === -1
    ? { camino: href, query: new URLSearchParams() }
    : { camino: href.slice(0, i), query: new URLSearchParams(href.slice(i + 1)) };
}

function calzaCamino(camino: string, pathname: string): boolean {
  return pathname === camino || pathname.startsWith(camino + "/");
}

function calzaQuery(query: URLSearchParams, actual: URLSearchParams): boolean {
  for (const [k, v] of query) if (actual.get(k) !== v) return false;
  return true;
}

/**
 * El `href` que se resalta, o `null` si ninguno.
 *
 * @param hrefs     Los hrefs de todos los ítems de la barra.
 * @param pathname  El camino actual (`usePathname`).
 * @param actual    La query actual (`useSearchParams`), o nada.
 */
export function hrefActivo(
  hrefs: readonly string[],
  pathname: string,
  actual: URLSearchParams | null | undefined
): string | null {
  const params = actual ?? new URLSearchParams();
  let sinQuery: string | null = null;
  for (const href of hrefs) {
    const { camino, query } = partir(href);
    if (!calzaCamino(camino, pathname)) continue;
    if ([...query].length > 0) {
      if (calzaQuery(query, params)) return href;
    } else if (sinQuery === null) {
      sinQuery = href;
    }
  }
  return sinQuery;
}
