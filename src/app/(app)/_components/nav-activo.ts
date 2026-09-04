// Which sidebar href is active. Most specific wins: an href whose query pairs
// all match beats a query-less href on the same path.
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
