/**
 * CSP nonce generation and header building.
 *
 * Strict Content Security Policy — no 'unsafe-inline' on script-src.
 * A fresh nonce is generated per request in proxy.ts.
 * The nonce is passed to the layout via the x-csp-nonce response header.
 *
 * AC16: script-src must not contain 'unsafe-inline'.
 */

/**
 * Generate a cryptographically random 16-byte base64 nonce.
 * Called once per incoming request in proxy.ts.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

/**
 * Build the full Content-Security-Policy header value for a given nonce.
 *
 * script-src:
 *   'self'           – same-origin scripts
 *   'nonce-{n}'      – Next.js inline runtime scripts (injected via nonce prop)
 *   'strict-dynamic' – trusted scripts can load further scripts
 *   No 'unsafe-inline', no 'unsafe-eval'.
 *
 * style-src:
 *   'self' 'nonce-{n}'. Sin 'unsafe-inline'.
 *
 *   Acá decía que Tailwind v4 genera estilos en línea en tiempo de ejecución y
 *   que por eso hacía falta 'unsafe-inline'. Se comprobó en un navegador contra
 *   un build de producción y no es así: Tailwind emite una hoja de estilos, que
 *   'self' ya cubre. Lo que sí producía atributos `style` eran siete
 *   `style={{ width }}` nuestros, en las barras de progreso, y ésos pasaron a
 *   una clase — ver `src/lib/ui/ancho-de-barra.ts`.
 *
 *   Con el cambio hecho: cero violaciones en producción. En desarrollo salen
 *   diecisiete y son del overlay de Next, no del producto.
 */
/**
 * Where the browser may send error reports.
 *
 * Derived from the configured DSN rather than hardcoded. The literal
 * `https://o0.ingest.sentry.io` that used to be here is Sentry's placeholder
 * host from their docs, not an ingest endpoint anyone owns — so the day
 * somebody set a real DSN, the CSP would have blocked every report and the
 * only symptom would be errors quietly not arriving.
 *
 * Returns nothing when Sentry is off, which it is today: an allowance for a
 * host we never contact is an allowance an attacker can use.
 */
function sentryOrigin(): string {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!dsn) return "";
  try {
    return ` ${new URL(dsn).origin}`;
  } catch {
    return "";
  }
}

export function buildCsp(nonce: string): string {
  const directives: string[] = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    /*
     * Sin 'unsafe-inline', y eso costó sacar siete `style={{ width }}`.
     *
     * Con esa directiva puesta, cualquier punto de inyección de HTML permite
     * meter CSS: exfiltrar datos con selectores de atributo más
     * `background-image`, tapar botones, dibujar encima de lo que la persona
     * cree que está apretando. Con `script-src` ya cerrado, el CSS inyectado
     * era la palanca que quedaba.
     *
     * El nonce NO cubre los atributos `style` del marcado, sólo los bloques
     * `<style>`. Comprobado en el navegador: con esta directiva, un
     * `style="width: 42px"` queda en el DOM y no se aplica. Por eso las barras
     * de progreso pasaron a una clase de Tailwind — ver
     * `src/lib/ui/ancho-de-barra.ts`.
     *
     * Verificado contra un build de producción: cero violaciones. En desarrollo
     * salen diecisiete, y son del overlay de Next, no del producto.
     */
    `style-src 'self' 'nonce-${nonce}'`,
    `connect-src 'self'${sentryOrigin()}`,
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  return directives.join("; ");
}
