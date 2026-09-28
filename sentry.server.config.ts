/**
 * Sentry del lado del servidor.
 *
 * Lo carga `instrumentation.ts` (`register()`), sólo con `NEXT_RUNTIME ===
 * "nodejs"` y `SENTRY_DSN` puesta: sin DSN el paquete no se importa. No hay
 * config de edge ni de cliente a propósito: no corre Sentry ahí, y el de
 * cliente metería @sentry/nextjs en el bundle contra el tope de `pnpm peso`.
 *
 * Set SENTRY_DSN in Vercel env vars (server-only, NOT NEXT_PUBLIC_*) to enable.
 */
import * as Sentry from "@sentry/nextjs";
import { limpiarEventoDeSentry } from "@/lib/observability/sentry-scrub";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    sendDefaultPii: false,
    // AC18 + #137: mensaje, breadcrumbs, cabeceras, cookies, extra y user.
    beforeSend: (event) => limpiarEventoDeSentry(event),
    // Las transacciones llevan la misma URL, cabeceras y cookies que un error.
    beforeSendTransaction: (event) => limpiarEventoDeSentry(event),
  });
}
