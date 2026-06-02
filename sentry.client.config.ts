/**
 * Sentry client-side initialization.
 * This file is auto-loaded by @sentry/nextjs when it detects the file at the root.
 *
 * Set NEXT_PUBLIC_SENTRY_DSN in Vercel env vars to enable.
 * Without the DSN, Sentry is silently disabled.
 */

import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    // Replay is opt-in — adds ~50KB to the client bundle.
    // Enable when session replay is needed for debugging.
    // replaysSessionSampleRate: 0.01,
    // replaysOnErrorSampleRate: 1.0,
    beforeSend(event) {
      // Strip any PII that may have leaked into error messages.
      // This is a last-resort filter — AC18 requires PII redaction at the source.
      if (event.exception?.values) {
        event.exception.values.forEach((exception) => {
          if (exception.value) {
            // Redact Argentine DNI patterns
            exception.value = exception.value.replace(
              /\bDNI?\s*[\d.]+/gi,
              "DNI [REDACTED]"
            );
            // Redact policy number patterns (0000-9999 format)
            exception.value = exception.value.replace(
              /\bpóliza\s*[\d-]+/gi,
              "póliza [REDACTED]"
            );
          }
        });
      }
      return event;
    },
  });
}
