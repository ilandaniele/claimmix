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
 *   'self' 'unsafe-inline' – Tailwind v4 generates inline styles at runtime;
 *   style nonces are not supported by Tailwind v4's PostCSS model.
 *
 * connect-src includes Supabase so Auth/Realtime/Storage calls work.
 */
export function buildCsp(nonce: string): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

  const directives: string[] = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${supabaseUrl} wss://*.supabase.co https://o0.ingest.sentry.io`,
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  return directives.join("; ");
}
