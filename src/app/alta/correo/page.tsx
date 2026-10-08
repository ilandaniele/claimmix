/**
 * /alta/correo — donde la persona elige su contraseña al volver del enlace de
 * «Activar tu cuenta».
 *
 * Pública y sólo para anónimos (proxy.ts): quien ya tiene sesión no tiene nada
 * que hacer acá. No consulta la base: lo que hace falta para crear la cuenta
 * viaja sellado en `?t=`, y un enlace vencido o adulterado se muestra igual que
 * uno vencido.
 *
 * El enlace es una credencial de un solo destinatario: `referrer: no-referrer`
 * evita que viaje a los sitios a los que se llegue desde esta pantalla (los
 * términos, la política de privacidad).
 */

import Link from "next/link";

import { getT, type ClaveDelServidor, type Locale } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { abrirToken } from "@/server/alta/token-de-registro";

import { crearCuentaDesdeCorreo } from "./actions";

export const metadata = {
  title: "Elegí tu contraseña — ClaimMix",
  referrer: "no-referrer",
} as const;

const CLASE_DEL_CAMPO =
  "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-500/15 dark:border-slate-600 dark:placeholder-slate-500";

const CLASE_DE_LA_ETIQUETA = "mb-1.5 block text-sm font-medium text-slate-700";

const ERRORES: Record<string, ClaveDelServidor> = {
  clave: "alta.correo.error.clave",
  distintas: "alta.correo.error.distintas",
  intentos: "login.errores.demasiados_intentos",
  falla: "alta.correo.error.falla",
};

const ultimo = (v: string | string[] | undefined) => (Array.isArray(v) ? v.at(-1) : v);

function Tarjeta({ titulo, locale, children }: { titulo: string; locale: Locale; children: React.ReactNode }) {
  return (
    <main lang={locale} className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-[26rem] rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
        <h1 className="mb-4 text-[15px] font-semibold tracking-tight text-slate-900">{titulo}</h1>
        {children}
      </div>
    </main>
  );
}

export default async function AltaCorreoPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[]; e?: string | string[] }>;
}) {
  const { t: crudo, e } = await searchParams;
  const enlace = ultimo(crudo);
  const datos = abrirToken(enlace);
  // El idioma en que pidió el alta; sin enlace válido, el de este navegador.
  const locale = datos?.locale ?? (await getServerLocale());
  const t = getT(locale);

  if (!datos || !enlace) {
    return (
      <Tarjeta titulo={t("alta.correo.vencido.titulo")} locale={locale}>
        <p className="mb-4 text-sm text-slate-600">{t("alta.correo.vencido.texto")}</p>
        <Link href="/registro" className="text-sm font-medium text-slate-800 underline underline-offset-2">
          {t("alta.correo.vencido.volver")}
        </Link>
      </Tarjeta>
    );
  }

  const motivo = ultimo(e);
  const claveError = motivo !== undefined && Object.hasOwn(ERRORES, motivo) ? ERRORES[motivo] : null;

  return (
    <Tarjeta titulo={t("alta.correo.titulo")} locale={locale}>
      <p className="mb-1 text-sm font-medium text-slate-800">{t("alta.correo.para").replace("{correo}", datos.e)}</p>
      <p className="mb-4 text-sm text-slate-600">{t("alta.correo.ayuda")}</p>

      {claveError && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
        >
          {t(claveError)}
        </div>
      )}

      <form action={crearCuentaDesdeCorreo} className="space-y-4">
        <input type="hidden" name="t" value={enlace} />
        <div>
          <label htmlFor="alta-correo-clave" className={CLASE_DE_LA_ETIQUETA}>
            {t("alta.correo.clave")}
          </label>
          <input
            id="alta-correo-clave"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={128}
            className={CLASE_DEL_CAMPO}
          />
        </div>
        <div>
          <label htmlFor="alta-correo-repetir" className={CLASE_DE_LA_ETIQUETA}>
            {t("alta.correo.repetir")}
          </label>
          <input
            id="alta-correo-repetir"
            name="repetir"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={128}
            className={CLASE_DEL_CAMPO}
          />
        </div>
        <button
          type="submit"
          className="w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30"
        >
          {t("alta.correo.crear")}
        </button>
      </form>
    </Tarjeta>
  );
}
