/**
 * Next.js instrumentation hook.
 * Called once when the server starts — used to initialize Sentry server-side.
 *
 * Next.js 15+ supports this file natively; no experimental flag needed in Next 16.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    // Edge runtime — import a lightweight edge-compatible config if needed.
    // For MVP, Sentry server config only runs in Node runtime.
  }
}
