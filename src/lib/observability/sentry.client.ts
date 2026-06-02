/**
 * Sentry client-side configuration stub.
 * The actual initialization is in sentry.client.config.ts at the project root.
 * This module exports a typed captureException wrapper for Client Components.
 */

"use client";

/**
 * Capture an exception in Sentry (client-side).
 * No-ops if NEXT_PUBLIC_SENTRY_DSN is not set (development without Sentry).
 */
export async function captureClientException(
  error: unknown,
  context?: Record<string, unknown>
): Promise<void> {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(error, { extra: context });
  } catch {
    // If Sentry fails, do not let that break the app.
    console.error("[Sentry] Failed to capture exception:", error);
  }
}
