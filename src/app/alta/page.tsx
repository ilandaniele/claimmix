/**
 * /alta — segundo paso del alta: qué viene a hacer la persona que ya tiene cuenta.
 *
 * Es el destino de Google (`newUserCallbackURL`), de quien vuelve del enlace del
 * correo y de quien, con la cuenta ya hecha, todavía no tiene perfil: /pendiente
 * la manda acá. Exige sesión y NO exige perfil, así que vive fuera de `(app)`. El
 * proxy la trata como cualquier ruta privada: no está en PUBLIC_PREFIXES ni en
 * SOLO_ANONIMOS.
 *
 * Es un componente de servidor y un formulario de servidor: funciona sin
 * JavaScript, sin cookies y sin envío automático. Lo que se crea es lo que la
 * persona escribe acá; nada viaja precargado desde el paso anterior.
 *
 * Qué se muestra, en orden: con perfil va a /bandeja; sin el correo verificado,
 * «revisá tu correo»; una dirección de operación no crea espacios; con el alta
 * cerrada para la dirección, el texto neutro más el de «mi empresa ya usa
 * ClaimMix»; y si no, los dos caminos.
 *
 * «Mi empresa ya usa ClaimMix» no consulta la base ni busca a la empresa por el
 * dominio del correo, así que no dice qué empresas existen. Pide que un
 * administrador invite la dirección de la sesión. Si ESTE navegador trae una
 * invitación para esta dirección (`invitacionDeLaSesion` lee la cookie, no la base),
 * el enlace a /invitacion reemplaza ese pedido y el camino se muestra abierto.
 * Una cuenta de este paso no entra por el SSO de la empresa: el SSO rechaza a
 * quien ya existe sin perfil, así que el texto no lo ofrece.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { altaAbierta } from "@/lib/auth/registro-permitido";
import { isOperatorEmail } from "@/lib/auth/require-operator";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRowOrThrow } from "@/lib/auth/user-row";
import { getT, type ClaveDelServidor } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { invitacionDeLaSesion } from "@/server/alta/invitacion";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import { ERRORES_DE_ALTA, type ErrorDeAlta } from "@/server/alta/validar";
import { wabaPropia } from "@/server/alta/waba-propia-activa";

import { crearMiEspacio } from "./actions";
import { Tarjeta } from "./Tarjeta";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${getT(await getServerLocale())("alta.pestana")} — ClaimMix` };
}

const CLASE_DEL_CAMPO =
  "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-500/15 dark:border-slate-600 dark:placeholder-slate-500";

const CLASE_DEL_CAMINO = "rounded-xl border border-slate-200 px-4 py-3";

const CLASE_DEL_RESUMEN = "cursor-pointer text-sm font-semibold text-slate-800";

/** La clave del texto de un motivo; uno que no está en la lista no muestra nada. */
function claveDelError(e: string | string[] | undefined): ClaveDelServidor | null {
  const motivo = Array.isArray(e) ? e.at(-1) : e;
  return (ERRORES_DE_ALTA as readonly string[]).includes(motivo ?? "")
    ? (`alta.error.${motivo as ErrorDeAlta}` as const)
    : null;
}

export default async function AltaPage({ searchParams }: { searchParams: Promise<{ e?: string | string[] }> }) {
  const usuario = (await getSessionContext())?.user;
  if (!usuario) redirect("/login");
  // Una falla de la base tira y muestra la pantalla de error: nunca se confunde con «sin espacio».
  if (await getUserRowOrThrow(usuario.id)) redirect("/bandeja");

  const locale = await getServerLocale();
  const t = getT(locale);
  const salir = t("alta.salir");

  if (usuario.emailVerified !== true) {
    return (
      <Tarjeta titulo={t("alta.noVerificado.titulo")} locale={locale} etiquetaSalir={salir}>
        <p className="text-sm text-slate-600">{t("alta.noVerificado.texto")}</p>
      </Tarjeta>
    );
  }
  if (isOperatorEmail(usuario.email)) {
    return (
      <Tarjeta titulo={t("alta.operador.titulo")} locale={locale} etiquetaSalir={salir}>
        <p className="text-sm text-slate-600">{t("alta.operador.texto")}</p>
      </Tarjeta>
    );
  }

  // Sólo la cookie, sin base: lo mismo para las dos pantallas que ofrecen entrar a una empresa que ya usa ClaimMix.
  const conInvitacion = (await invitacionDeLaSesion(usuario.email)) !== null;
  // Texto fijo con la dirección de la sesión: dos direcciones de dominios distintos ven lo mismo.
  const unirme = conInvitacion ? (
    <Link href="/invitacion" className="font-medium text-violet-700 underline underline-offset-2">
      {t("alta.seguirInvitacion")}
    </Link>
  ) : (
    t("alta.unirme").replace("{correo}", () => usuario.email)
  );

  if (!altaAbierta(usuario.email)) {
    return (
      <Tarjeta titulo={t("alta.cerrada.titulo")} locale={locale} etiquetaSalir={salir}>
        <p className="text-sm text-slate-600">{t("alta.cerrada.texto")}</p>
        {/* Con su rótulo: pegado al texto de arriba parecería un segundo pedido contradictorio, y es el de quien ya tiene empresa. */}
        <p className="mt-4 text-sm font-semibold text-slate-800">{t("alta.camino.unirme")}</p>
        <p className="mt-1 text-sm text-slate-600">{unirme}</p>
      </Tarjeta>
    );
  }

  const claveError = claveDelError((await searchParams).e);

  return (
    <Tarjeta titulo={t("alta.titulo")} locale={locale} etiquetaSalir={salir}>
      <p className="mb-4 text-sm text-slate-600">{t("alta.ayuda")}</p>

      {claveError && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
        >
          {t(claveError)}
        </div>
      )}

      {/* `<details name>` y no `?camino=`: filaDeUsuario no cachea null y cada render de una cuenta sin perfil va a la base. */}
      <div className="space-y-3">
        <details name="camino" open={claveError !== null} className={CLASE_DEL_CAMINO}>
          <summary className={CLASE_DEL_RESUMEN}>{t("alta.camino.empresa")}</summary>
          <form id="alta-form" action={crearMiEspacio} className="mt-4 space-y-4">
            <div>
              <label htmlFor="alta-empresa" className="mb-1.5 block text-sm font-medium text-slate-700">
                {t("alta.empresa")}
              </label>
              <input
                id="alta-empresa"
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
              <label htmlFor="alta-whatsapp" className="mb-1.5 block text-sm font-medium text-slate-700">
                {t("alta.whatsapp")}
              </label>
              <input
                id="alta-whatsapp"
                name="whatsapp"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                required
                placeholder="+…"
                aria-describedby="alta-whatsapp-ayuda"
                className={CLASE_DEL_CAMPO}
              />
              <p id="alta-whatsapp-ayuda" className="mt-1.5 text-xs text-slate-500">
                {t("alta.whatsapp.ayuda")}
                {wabaPropia()
                  ? ` ${t("alta.whatsapp.avisoPropia")}`
                  : numeroAutomatico()
                    ? ` ${t("alta.whatsapp.aviso")}`
                    : null}
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
              className="w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30"
            >
              {t("alta.crear")}
            </button>
          </form>
        </details>

        {/* Nunca dos `open` en el grupo: con un error del formulario queda abierto el de la empresa. */}
        <details name="camino" open={conInvitacion && claveError === null} className={CLASE_DEL_CAMINO}>
          <summary className={CLASE_DEL_RESUMEN}>{t("alta.camino.unirme")}</summary>
          <p className="mt-3 text-sm text-slate-600">{unirme}</p>
        </details>
      </div>
    </Tarjeta>
  );
}
