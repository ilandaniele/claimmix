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

// La v11 sacó `sendDefaultPii` y por defecto junta todo: cuerpos, cabeceras,
// variables locales, parámetros de consultas y prompts de IA. Cada categoría
// va apagada a mano; `Required` hace que una categoría nueva no compile hasta
// que alguien la decida.
type DataCollection = NonNullable<Parameters<typeof Sentry.init>[0]["dataCollection"]>;

const SIN_DATOS_DE_PERSONAS: Required<Omit<DataCollection, "frameContextLines">> = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // NODE_ENV vale production también en los previews; VERCEL_ENV los separa.
    // Prd, dev y QA son tres proyectos que dan production los tres: eso no se
    // distingue acá. Fuera de Vercel cae a NODE_ENV.
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    dataCollection: SIN_DATOS_DE_PERSONAS,
    // La v11 manda los spans en tandas por defecto y ahí ignora
    // `beforeSendTransaction`; con "static" la transacción sigue pasando por
    // el scrub. En la v12 se va y hay que pasarlo a `beforeSendSpan`.
    traceLifecycle: "static",
    // AC18 + #137: mensaje, breadcrumbs, cabeceras, cookies, extra y user.
    beforeSend: (event) => limpiarEventoDeSentry(event),
    // Las transacciones llevan la misma URL, cabeceras y cookies que un error.
    beforeSendTransaction: (event) => limpiarEventoDeSentry(event),
  });
}
