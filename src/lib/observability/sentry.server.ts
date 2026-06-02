/**
 * Sentry server-side helpers for Route Handlers and Server Actions.
 * The actual initialization is in sentry.server.config.ts at the project root.
 *
 * AC18: Never log PII (DNI, license plates, policy numbers).
 * Strip sensitive fields before passing context to Sentry.
 */

import "server-only";

/**
 * Capture an exception server-side.
 * No-ops if SENTRY_DSN is not set.
 *
 * @param error   The caught error or unknown value.
 * @param context Safe (non-PII) context to attach to the Sentry event.
 */
export async function captureServerException(
  error: unknown,
  context?: Record<string, unknown>
): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(error, {
      extra: context,
      // Tags must not contain PII.
      tags: {
        layer: "server",
      },
    });
  } catch {
    // Sentry must never break the app flow.
    console.error("[Sentry] Failed to capture server exception");
  }
}
