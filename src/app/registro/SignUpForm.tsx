/**
 * SignUpForm — el formulario de /registro, de servidor. El único JavaScript
 * propio es el del desafío (`DesafioTurnstile`).
 *
 * Un solo paso con dos botones que mandan a acciones distintas: «Continuar con
 * Google» (empezarAltaConGoogle) y «Crear cuenta con mi correo» (signUp). La
 * empresa, el WhatsApp y los términos son de los dos; el nombre y el correo, sólo
 * del segundo, así que no llevan `required`: el navegador no puede frenar a quien
 * va por Google. Los valida la acción.
 *
 * El botón del correo existe sólo si hay remitente del sistema: sin él no hay
 * cómo mandar el enlace. El desafío de Turnstile, sólo si están las dos claves, y
 * sólo frena ese botón. Su script lleva el nonce de la CSP.
 */

import Link from "next/link";

import type { getT } from "@/lib/i18n";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import { wabaPropia } from "@/server/alta/waba-propia-activa";

import { empezarAltaConGoogle, signUp } from "./actions";
import { DesafioTurnstile } from "./DesafioTurnstile";

const CLASE_DEL_CAMPO =
  "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-500/15 dark:border-slate-600 dark:placeholder-slate-500";

const CLASE_DE_LA_ETIQUETA = "mb-1.5 block text-sm font-medium text-slate-700";

export function SignUpForm({
  t,
  conCorreo,
  claveDeTurnstile,
  nonce,
}: {
  t: ReturnType<typeof getT>;
  conCorreo: boolean;
  /** La clave PÚBLICA del sitio; null si no hay desafío. */
  claveDeTurnstile: string | null;
  nonce: string | undefined;
}) {
  return (
    <form aria-label={t("registro.titulo")} className="space-y-4">
      <div>
        <label htmlFor="registro-empresa" className={CLASE_DE_LA_ETIQUETA}>
          {t("alta.empresa")}
        </label>
        <input
          id="registro-empresa"
          name="empresa"
          type="text"
          autoComplete="organization"
          required
          minLength={2}
          maxLength={80}
          className={CLASE_DEL_CAMPO}
        />
      </div>
      <div>
        <label htmlFor="registro-whatsapp" className={CLASE_DE_LA_ETIQUETA}>
          {t("alta.whatsapp")}
        </label>
        <input
          id="registro-whatsapp"
          name="whatsapp"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          placeholder="+54 9 …"
          aria-describedby="registro-whatsapp-ayuda"
          className={CLASE_DEL_CAMPO}
        />
        <p id="registro-whatsapp-ayuda" className="mt-1.5 text-xs text-slate-500">
          {t("alta.whatsapp.ayuda")}
          {wabaPropia() ? ` ${t("alta.whatsapp.avisoPropia")}` : numeroAutomatico() ? ` ${t("alta.whatsapp.aviso")}` : null}
        </p>
      </div>
      <label className="flex items-start gap-2.5 text-sm text-slate-600">
        <input
          type="checkbox"
          name="terminos"
          required
          className="mt-0.5 size-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
        />
        <span>
          {t("alta.terminos.prefijo")}{" "}
          <Link href="/terms" className="font-medium text-slate-800 underline underline-offset-2">
            {t("alta.terminos.terminos")}
          </Link>{" "}
          {t("alta.terminos.conector")}{" "}
          <Link href="/privacy" className="font-medium text-slate-800 underline underline-offset-2">
            {t("alta.terminos.privacidad")}
          </Link>
        </span>
      </label>

      <button
        type="submit"
        formAction={empezarAltaConGoogle}
        className="flex w-full items-center justify-center gap-2.5 rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/25 dark:border-slate-600"
      >
        <GoogleIcon />
        {t("registro.google")}
      </button>

      {conCorreo && (
        <>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="uppercase tracking-[0.08em]">{t("registro.o")}</span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>
          <div>
            <label htmlFor="registro-nombre" className={CLASE_DE_LA_ETIQUETA}>
              {t("usuarios.form.nombre")}
            </label>
            <input
              id="registro-nombre"
              name="full_name"
              type="text"
              autoComplete="name"
              maxLength={100}
              className={CLASE_DEL_CAMPO}
            />
          </div>
          <div>
            <label htmlFor="registro-correo" className={CLASE_DE_LA_ETIQUETA}>
              {t("auth.signIn.email")}
            </label>
            <input
              id="registro-correo"
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              aria-describedby="registro-correo-ayuda"
              className={CLASE_DEL_CAMPO}
            />
            <p id="registro-correo-ayuda" className="mt-1.5 text-xs text-slate-500">
              {t("registro.sinContraseña.ayuda")}
            </p>
          </div>

          {claveDeTurnstile && <DesafioTurnstile clave={claveDeTurnstile} nonce={nonce} />}

          <button
            type="submit"
            formAction={signUp}
            className="w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30"
          >
            {t("registro.correo.crear")}
          </button>
        </>
      )}
    </form>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
