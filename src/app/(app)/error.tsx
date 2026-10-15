/**
 * Cuando falla una pantalla del turno, la falla se queda en el contenido: la
 * barra lateral y la superior siguen ahí y se puede ir a otra pantalla.
 *
 * Va dentro del `LocaleProvider` del layout, así que usa el idioma de la cuenta.
 * No atrapa un error del layout mismo (la sesión, la fila del usuario): ése
 * sube a `global-error`.
 *
 * No manda nada a ningún lado: Sentry no tiene SDK de cliente. El `digest` se
 * muestra para que soporte lo busque en los registros del servidor.
 */

"use client";

import { useT } from "@/lib/i18n/LocaleContext";

import { Card } from "./_components/ui";

export default function ErrorDePantalla({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useT();

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10">
      <Card className="w-full max-w-[26rem] p-7 text-center">
        <div role="alert">
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">{t("error.pantalla.titulo")}</h1>
          <p className="mt-2 text-sm text-slate-600">{t("error.generic")}</p>
        </div>
        <button
          type="button"
          onClick={() => retry()}
          className="mt-6 w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30"
        >
          {t("error.pantalla.reintentar")}
        </button>
        {error.digest && (
          <p className="mt-4 text-xs text-slate-500">{t("error.pantalla.codigo").replace("{codigo}", error.digest)}</p>
        )}
      </Card>
    </div>
  );
}
