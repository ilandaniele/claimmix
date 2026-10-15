/**
 * Lo que se ve cuando falla hasta el layout raíz.
 *
 * Reemplaza el documento entero, así que trae su propio <html> y <body> y no
 * tiene LocaleContext ni el script del tema: el layout que los ponía es lo que
 * se rompió. Por eso el texto va en los dos idiomas a la vez, cada uno marcado
 * con su `lang`, y la pantalla es siempre clara. Es un camino raro: un error de
 * una pantalla lo atrapa `(app)/error.tsx`, que sí conserva el shell.
 *
 * No manda nada a ningún lado: Sentry no tiene SDK de cliente. El `digest` se
 * muestra para que soporte lo busque en los registros del servidor.
 *
 * Mínimo a propósito: cada kilobyte de acá cuenta en el tope de `pnpm peso`.
 */

"use client";

import "./globals.css";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="es-AR" className="h-full antialiased">
      <head>
        <title>ClaimMix</title>
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
          <div
            role="alert"
            className="w-full max-w-[26rem] rounded-2xl border border-slate-200 bg-white p-7 text-center shadow-sm"
          >
            <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">
              Algo salió mal
              <span lang="en-US" className="mt-0.5 block font-normal text-slate-600">
                Something went wrong
              </span>
            </h1>
            <p className="mt-3 text-sm text-slate-600">
              Ocurrió un error inesperado. Intentá de nuevo.
            </p>
            <p lang="en-US" className="mt-1 text-sm text-slate-600">
              An unexpected error occurred. Please try again.
            </p>
            <button
              type="button"
              onClick={() => retry()}
              className="mt-6 w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30"
            >
              Reintentar
              <span lang="en-US" className="font-normal">
                {" / Try again"}
              </span>
            </button>
            {error.digest && (
              <p className="mt-4 text-xs text-slate-500">
                Ref. {error.digest}
              </p>
            )}
          </div>
        </main>
      </body>
    </html>
  );
}
