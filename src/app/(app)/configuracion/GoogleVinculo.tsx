/**
 * Si esta cuenta puede entrar con Google, y el botón para que pueda.
 *
 * El «Continuar con Google» del login sirve para entrar, no para vincular: si
 * la cuenta ya existe con contraseña y el correo nunca se verificó, Better Auth
 * rechaza la fusión y devuelve al login. Ver `vincular-google.ts`, que explica
 * por qué esa negativa es correcta y por qué desde acá sí es seguro.
 *
 * Server Component: pregunta las cuentas vinculadas en el servidor y no expone
 * ningún token a la pantalla — sólo qué proveedores hay.
 */

import { headers } from "next/headers";
import { Link2, ShieldCheck } from "lucide-react";

import { auth } from "@/lib/auth";
import { getT, type TranslationKey } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";

import { vincularGoogle } from "./vincular-google";

/** Qué avisa la vuelta de Google, si venimos de ahí. */
const AVISOS: Record<string, { clave: TranslationKey; tono: "ok" | "error" }> = {
  ok: { clave: "google.vinculado", tono: "ok" },
  error: { clave: "google.vinculoError", tono: "error" },
};

export async function GoogleVinculo({ aviso }: { aviso?: string }) {
  const t = getT(await getServerLocale());

  let yaVinculada = false;
  try {
    const cuentas = await auth.api.listUserAccounts({ headers: await headers() });
    yaVinculada = cuentas.some((c) => c.providerId === "google");
  } catch {
    // Si no se puede averiguar, se ofrece vincular: el peor caso es que la
    // persona apriete y Better Auth le diga que ya estaba.
  }

  const nota = aviso ? AVISOS[aviso] : undefined;

  return (
    <div className="space-y-3">
      {nota && (
        <p
          role="status"
          className={
            nota.tono === "ok"
              ? "rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
              : "rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          }
        >
          {t(nota.clave)}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-slate-700">Google</p>
          {yaVinculada ? (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <ShieldCheck size={13} aria-hidden="true" />
              {t("google.yaVinculada")}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-slate-500">{t("google.sinVincular")}</p>
          )}
        </div>

        {!yaVinculada && (
          <form action={vincularGoogle}>
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/25 dark:border-slate-600"
            >
              <Link2 size={14} aria-hidden="true" />
              {t("google.vincular")}
            </button>
          </form>
        )}
      </div>

      <p className="text-xs text-slate-500">{t("google.ayuda")}</p>
    </div>
  );
}
