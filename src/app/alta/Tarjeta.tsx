/**
 * La tarjeta de las pantallas de antes de entrar al panel (/alta, /preparando):
 * título, contenido y «Cerrar sesión» debajo. Viven fuera de `(app)`, así que no
 * tienen barra ni menú. Salir es un POST de documento (no una Server Action) para que
 * /login se pida de cero y no herede el CSP ni el SDK de Meta de /conectar-whatsapp.
 */

import type { Locale } from "@/lib/i18n";

export function Tarjeta({
  titulo,
  locale,
  etiquetaSalir,
  children,
}: {
  titulo: string;
  locale: Locale;
  etiquetaSalir: string;
  children: React.ReactNode;
}) {
  return (
    <main lang={locale} className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-[26rem]">
        <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          <h1 className="mb-4 text-[15px] font-semibold tracking-tight text-slate-900">{titulo}</h1>
          {children}
        </div>
        <form method="post" action="/api/auth/salir" className="mt-5 text-center">
          <button
            type="submit"
            className="rounded text-sm font-medium text-slate-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
          >
            {etiquetaSalir}
          </button>
        </form>
      </div>
    </main>
  );
}
