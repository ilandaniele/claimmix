/**
 * El 404 de toda la aplicación: una URL que no existe, o un `notFound()` de una
 * pantalla (un caso o un cliente que no hay, o que no es de este espacio).
 *
 * Es de servidor, así que el idioma sale de la cookie del dispositivo. Vive
 * fuera del shell de `(app)`: el que llega acá puede ni tener sesión.
 */

import Link from "next/link";

import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";

export default async function NotFound() {
  const locale = await getServerLocale();
  const t = getT(locale);

  return (
    <main lang={locale} className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-[26rem] rounded-2xl border border-slate-200 bg-white p-7 text-center shadow-sm">
        <p className="text-sm font-semibold text-violet-700 dark:text-violet-300">404</p>
        <h1 className="mt-1 text-[15px] font-semibold tracking-tight text-slate-900">{t("noEncontrado.titulo")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("noEncontrado.texto")}</p>
        <Link
          href="/"
          className="mt-6 block w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30"
        >
          {t("noEncontrado.volver")}
        </Link>
      </div>
    </main>
  );
}
