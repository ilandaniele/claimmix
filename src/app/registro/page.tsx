/**
 * Registration page — alta de una cuenta y de su espacio, en un solo paso.
 *
 * Fuera del LocaleProvider: el idioma se resuelve acá, en el servidor. Es un
 * componente de servidor y funciona sin JavaScript. La acción que corresponde a
 * cada botón está en `SignUpForm`.
 *
 * El motivo de un rechazo vuelve en `?e=`; uno que no está en la lista no muestra
 * nada.
 */

import { headers } from "next/headers";
import Link from "next/link";

import { getT, type ClaveDelServidor } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { clavesDeTurnstile } from "@/server/alta/turnstile";
import { remitenteDelSistema } from "@/server/notify/remitente-sistema";

import { SignUpForm } from "./SignUpForm";

export const metadata = {
  title: "Crear cuenta — ClaimMix",
};

const ERRORES: Record<string, ClaveDelServidor> = {
  datos: "alta.error.datos",
  intentos: "login.errores.demasiados_intentos",
};

export default async function RegistroPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string | string[] }>;
}) {
  const locale = await getServerLocale();
  const t = getT(locale);
  const { e } = await searchParams;
  const motivo = Array.isArray(e) ? e.at(-1) : e;
  const claveError = motivo !== undefined && Object.hasOwn(ERRORES, motivo) ? ERRORES[motivo] : null;
  const nonce = (await headers()).get("x-csp-nonce") ?? undefined;

  return (
    <main lang={locale} className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">ClaimMix</h1>
          <p className="mt-1 text-sm text-slate-500">{t("registro.subtitulo")}</p>
        </div>

        {/* Sign-up card */}
        <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="mb-2 text-lg font-medium text-slate-800">{t("registro.titulo")}</h2>
          <p className="mb-6 text-sm text-slate-600">{t("registro.ayuda")}</p>

          {claveError && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
            >
              {t(claveError)}
            </div>
          )}

          <SignUpForm
            t={t}
            conCorreo={remitenteDelSistema() !== null}
            claveDeTurnstile={clavesDeTurnstile()?.sitio ?? null}
            nonce={nonce}
          />
        </div>

        <p className="mt-4 text-center text-sm text-slate-500">
          {t("registro.yaTenes")}{" "}
          <Link href="/login" className="font-medium text-slate-800 underline-offset-2 hover:underline">
            {t("auth.signIn.title")}
          </Link>
        </p>
      </div>
    </main>
  );
}
