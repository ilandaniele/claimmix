/**
 * Resolve the base URL for internal worker dispatch.
 *
 * Priority order (AC7):
 *   1. VERCEL_URL   — injected by Vercel at build/runtime (does NOT include https://).
 *   2. NEXT_PUBLIC_SITE_URL — explicit site URL (must include protocol).
 *   3. Fallback: http://localhost:3000 for local development.
 *
 * The returned URL never has a trailing slash.
 */

/**
 * Returns the base URL (scheme + host) used to dispatch internal worker requests.
 *
 * Examples:
 *   VERCEL_URL=my-project.vercel.app           → "https://my-project.vercel.app"
 *   NEXT_PUBLIC_SITE_URL=https://claimmix.com  → "https://claimmix.com"
 *   (neither set)                              → "http://localhost:3000"
 */
export function getWorkerBaseUrl(): string {
  // VERCEL_URL is set automatically by Vercel and contains only the hostname (no protocol).
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl && vercelUrl.trim()) {
    return `https://${vercelUrl.trim()}`;
  }

  // NEXT_PUBLIC_SITE_URL should include the protocol (e.g. https://claimmix.com).
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (siteUrl && siteUrl.trim()) {
    // Strip trailing slash for a consistent base URL.
    return siteUrl.trim().replace(/\/$/, "");
  }

  return "http://localhost:3000";
}
