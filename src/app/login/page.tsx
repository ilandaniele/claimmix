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
const ERRORES: Record<string, string> = {
  google_signin_failed:
    "No pudimos empezar el ingreso con Google. Probá de nuevo o entrá con tu contraseña.",
  auth_callback_failed:
    "Google nos devolvió, pero no pudimos completar el ingreso. Entrá con tu contraseña y escribinos si sigue pasando.",
  account_not_linked:
    "Ya existe una cuenta con ese correo y todavía no está vinculada a Google. Entrá con tu contraseña esta vez.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string; error?: string }>;
}) {
  const { aviso, error } = await searchParams;
  const mensajeError = error
    ? (ERRORES[error] ?? "No pudimos completar el ingreso. Probá de nuevo.")
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

          {/*
            El aviso que deja el alta.

            Dice lo mismo para una cuenta recién creada que para una dirección
            que ya tenía una. Es a propósito: si el alta contestara distinto en
            cada caso, alcanzaría con probar direcciones para averiguar quién
            trabaja acá.
          */}
          {aviso === "usa_tu_cuenta" && (
            <p
              role="status"
              className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
            >
              Si la dirección es válida, ya podés entrar con tu contraseña. Si no
              la recordás, pedí un enlace abajo.
            </p>
          )}

          <SignInForm />
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
