/**
 * Demo dentro de la app — Server Component.
 *
 * La misma demo de `/demo` (`DemoPublic`, contra `/api/demo/public-analyze` y su
 * tope por IP), pero con la barra a la vista: quien ya tiene sesión la abre desde
 * «Demo» sin perder el menú. `/demo`, sin sesión ni barra, sigue siendo la que ve
 * un prospecto.
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 */

import { DemoPublic } from "@/app/demo/DemoPublic";
import { getT } from "@/lib/i18n";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";
import { tituloDePantalla } from "@/app/(app)/_components/titulo-de-pantalla";

export const generateMetadata = tituloDePantalla("nav.demo");

export default async function DemostracionPage() {
  const t = getT(await getAccountLocale());

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-5 pt-1 sm:px-6">
        <h1 className="text-balance text-[22px] font-semibold tracking-tight text-slate-900 sm:text-[26px]">
          {t("nav.demo")}
        </h1>
      </div>

      {/*
        * La demo es toda en castellano (ejemplos, rótulos, resultado y los textos del
        * diccionario que usa) sea cual sea el idioma de la cuenta, así que se declara
        * así: bajo `lang="en-US"` un lector de pantalla la leería con fonemas
        * ingleses (SC 3.1.2). El título de arriba sí sigue a la cuenta.
        */}
      <div lang="es-AR" className="flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
        <DemoPublic />
      </div>
    </div>
  );
}
