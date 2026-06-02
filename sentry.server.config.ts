/**
 * Sentry server-side initialization.
 * This file is auto-loaded by @sentry/nextjs for server-side error tracking.
 *
 * Set SENTRY_DSN in Vercel env vars (server-only, NOT NEXT_PUBLIC_*) to enable.
 */

import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    beforeSend(event) {
      // AC18: Redact PII from error messages before sending to Sentry.
      if (event.exception?.values) {
        event.exception.values.forEach((exception) => {
          if (exception.value) {
            exception.value = exception.value
              .replace(/\bDNI?\s*[\d.]+/gi, "DNI [REDACTED]")
              .replace(/\bpóliza\s*[\d-]+/gi, "póliza [REDACTED]")
              .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{3}\b/g, "[PLATE_REDACTED]");
          }
        });
      }
      // Strip request bodies from server errors (may contain PII).
      if (event.request) {
        delete event.request.data;
      }
      return event;
    },
  });
}
