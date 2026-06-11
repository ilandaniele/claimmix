/**
 * Resolve the base URL for internal worker dispatch.
 *
 * Priority order:
 *   1. NEXT_PUBLIC_APP_URL  — public production domain (must include protocol).
 *   2. NEXT_PUBLIC_SITE_URL — explicit site URL (must include protocol).
 *   3. VERCEL_URL           — injected by Vercel (hostname only, no protocol).
 *   4. Fallback: http://localhost:3000 for local development.
 *
 * VERCEL_URL is the per-deployment generated URL (e.g. claimmix-abc123.vercel.app),
 * which is covered by Vercel Deployment Protection (SSO) by default — a server-side
 * fetch to it gets a 401 challenge page instead of reaching the route handler.
 * The public app/site URL must therefore take precedence in production.
 *
 * The returned URL never has a trailing slash.
 */

/**
 * Returns the base URL (scheme + host) used to dispatch internal worker requests.
 *
 * Examples:
 *   NEXT_PUBLIC_APP_URL=https://claimmix.vercel.app → "https://claimmix.vercel.app"
 *   NEXT_PUBLIC_SITE_URL=https://claimmix.com       → "https://claimmix.com"
 *   VERCEL_URL=my-project.vercel.app                → "https://my-project.vercel.app"
 *   (none set)                                      → "http://localhost:3000"
 */
export function getWorkerBaseUrl(): string {
  // Public app URL — not subject to Vercel Deployment Protection.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl && appUrl.trim()) {
    return appUrl.trim().replace(/\/$/, "");
  }

  // NEXT_PUBLIC_SITE_URL should include the protocol (e.g. https://claimmix.com).
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (siteUrl && siteUrl.trim()) {
    return siteUrl.trim().replace(/\/$/, "");
  }

  // VERCEL_URL is set automatically by Vercel and contains only the hostname (no protocol).
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl && vercelUrl.trim()) {
    return `https://${vercelUrl.trim()}`;
  }

  return "http://localhost:3000";
}
