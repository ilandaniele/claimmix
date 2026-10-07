/**
 * La pantalla de entrada.
 *
 * ── Por qué estaba ilegible ─────────────────────────────────────────────────
 *
 * Estaba escrita en la paleta `zinc` y el resto del producto usa `slate`. Eso
 * no sería un problema salvo por cómo se resuelve el modo oscuro acá:
 * `globals.css` no redefine tokens, PISA las utilidades de Tailwind con
 * `!important` —`.dark .bg-white`, `.dark .text-slate-800`— y esa lista sólo
 * nombra `slate`.
 *
 * Resultado: `bg-white` de la tarjeta SÍ se oscurecía, y `text-zinc-700` de las
 * etiquetas NO se aclaraba. Texto casi negro sobre una tarjeta casi negra. El
 * script del tema vive en el layout RAÍZ, así que `.dark` llega también acá,
 * aunque el login esté fuera del shell de la app.
 *
 * Ahora usa `slate` como el resto y, donde el tono no está en esa lista
 * —`border-slate-300`, los violetas—, lo dice con variantes `dark:` explícitas
 * en vez de confiar en que alguien agregue la regla.
 */

import Link from "next/link";
import { ShieldCheck } from "lucide-react";

import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";

import { signInSso } from "./actions";
import { SignInForm } from "./SignInForm";

export const metadata = {
  title: "Iniciar sesión — ClaimMix",
};

/**
 * Lo que puede haber salido mal antes de llegar acá.
 *
 * Faltaba entero: la pantalla leía `aviso` y nunca `error`, así que un fallo de
 * Google terminaba redirigiendo a `/login?error=…` y se veía un formulario
 * limpio, sin una palabra. Desde afuera eso es «apreté y no pasó nada».
 */
export const ERRORES: Record<string, string> = {
  google_signin_failed:
    "No pudimos empezar el ingreso con Google. Probá de nuevo o entrá con tu contraseña.",
  auth_callback_failed:
    "Google nos devolvió, pero no pudimos completar el ingreso. Entrá con tu contraseña y escribinos si sigue pasando.",
  account_not_linked:
    "Ese correo ya tiene una cuenta con contraseña. Entrá con tu contraseña y, una vez adentro, vinculá Google desde Configuración — después el botón te va a funcionar.",
  /*
   * Better Auth lo manda cuando el gancho `user.create.before` niega el alta por
   * Google: el correo no está habilitado o su dominio exige el SSO. Un mismo texto
   * para los dos, sin decir cuál, y sin mandar a la contraseña a quien no tiene una.
   */
  unable_to_create_user:
    "No pudimos crear una cuenta con ese correo. Si tu empresa usa SSO, entrá con «Entrar con el SSO de mi empresa»; si no, escribinos y lo vemos.",
  // Del SSO de la empresa (B19): el texto dice qué hacer, no por qué falló por dentro.
  sso_requerido:
    "Tu empresa pide entrar con su SSO. Usá «Entrar con el SSO de mi empresa» e ingresá tu correo de la empresa.",
  sso_otro_inquilino:
    "Ese correo ya pertenece a otra cuenta de ClaimMix, así que no pudimos darte acceso por acá. Escribinos si creés que es un error.",
  sso_fallo:
    "No pudimos completar el ingreso con el SSO de tu empresa. Revisá que el correo sea el de la empresa y probá de nuevo en un rato, o entrá con tu contraseña.",
  // Google no probó el correo (gancho `user.validateUserInfo`): se le dice qué hacer, no por qué.
  email_no_verificado:
    "Google no tiene verificado ese correo, así que no podemos usarlo para entrar. Verificalo en tu cuenta de Google y probá de nuevo, o entrá con tu contraseña si tenés una.",
};

/**
 * El código de error, tolerando que venga repetido.
 *
 * Un parámetro repetido llega como array, y hacer `ERRORES[array]` no encuentra
 * nada y cae al texto genérico. Pasó de verdad: la URL de error traía su propia
 * query y Better Auth le sumaba la suya con `&`.
 *
 * Se queda con el ÚLTIMO, que es el que agrega quien más cerca estuvo del
 * fallo y por lo tanto el más específico.
 */
export function codigoDeError(error: string | string[] | undefined): string | null {
  if (!error) return null;
  return Array.isArray(error) ? (error.at(-1) ?? null) : error;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string; error?: string | string[] }>;
}) {
  const { aviso, error } = await searchParams;
  // Fuera del LocaleProvider: el idioma se resuelve acá, en el servidor.
  const locale = await getServerLocale();
  const t = getT(locale);
  const codigo = codigoDeError(error);
  const mensajeError = codigo
    ? (ERRORES[codigo] ??
       "No pudimos completar el ingreso. Entrá con tu contraseña y escribinos si sigue pasando.")
    : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-[26rem]">
        <div className="mb-7 text-center">
          <span className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
            <ShieldCheck size={13} aria-hidden="true" />
            Gestión de siniestros
          </span>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-slate-900">
            ClaimMix
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            Asistida por IA, decidida por personas
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          <h2 className="mb-5 text-[15px] font-semibold tracking-tight text-slate-900">
            Iniciar sesión
          </h2>

          {mensajeError && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
            >
              {mensajeError}
            </div>
          )}

          {/* El alta no abre sesión: manda el enlace y acá se avisa. */}
          {aviso === "revisa_tu_correo" && (
            <p
              role="status"
              lang={locale}
              className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
            >
              {t("login.aviso.revisaTuCorreo")}
            </p>
          )}

          <SignInForm />

          {/*
            El SSO de la empresa (B19). Un <details> y un formulario del servidor:
            no suma JavaScript a la pantalla de entrada. El dominio del correo
            decide a qué proveedor se va; si no hay SSO para ese dominio, vuelve
            acá con el mismo aviso que cualquier otro fallo.
          */}
          <details className="mt-3">
            <summary className="cursor-pointer rounded-full border border-slate-300 px-4 py-2.5 text-center text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/25 dark:border-slate-600">
              Entrar con el SSO de mi empresa
            </summary>
            <form action={signInSso} className="mt-3 space-y-3">
              <div>
                <label htmlFor="sso-email" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Correo de tu empresa
                </label>
                <input
                  id="sso-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-500/15 dark:border-slate-600 dark:placeholder-slate-500"
                  placeholder="analista@aseguradora.com"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30"
              >
                Continuar con el SSO
              </button>
            </form>
          </details>
        </div>

        {/*
          Antes no había ningún enlace acá, porque no había flujo: recuperar la
          contraseña pedía escribirle a un admin. Eso empuja a mandarlas por chat.
        */}
        <div className="mt-5 space-y-2 text-center text-sm text-slate-500">
          <p>
            <Link
              href="/recuperar"
              className="rounded font-medium text-slate-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
            >
              ¿Olvidaste tu contraseña?
            </Link>
          </p>
          <p>
            ¿No tenés cuenta?{" "}
            <Link
              href="/registro"
              className="rounded font-semibold text-violet-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:text-violet-300"
            >
              Crear cuenta
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
