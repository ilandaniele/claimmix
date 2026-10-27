/**
 * /invitacion — donde la persona invitada ve de quién es el espacio y decide.
 *
 * Pública (proxy.ts) y de servidor, sin JavaScript propio. El enlace del mail
 * lleva todo sellado en `?t=`; al volver de Google, donde ya no hay query, el
 * mismo valor está en la cookie `cm_invitacion`. Mirar la pantalla no escribe
 * nada: la cuenta y el perfil se crean recién al aceptar (ver actions.ts).
 *
 * Qué se muestra, en orden: «rechazada» si vuelve de rechazar; «vencida» si el
 * enlace no abre, venció, o quien invitó ya no puede invitar o el espacio se dio
 * de baja; «otra dirección» si la sesión abierta no es la invitada; «ya tenés un
 * espacio» si esa cuenta ya tiene perfil; «tu empresa pide el SSO» si el espacio
 * exige el SSO para el dominio invitado (ni Google ni la contraseña se ofrecen:
 * la cuenta nacería y la sesión se le negaría); con la sesión de la dirección
 * invitada, el botón de aceptar; y sin sesión, las tres opciones. Una dirección
 * Gmail con «+» o con puntos no ofrece Google: la cuenta vuelve con la casilla
 * base y no coincide con la invitada, así que sólo queda la contraseña.
 *
 * El enlace es una credencial de un solo destinatario: `referrer: no-referrer`
 * evita que viaje a los sitios a los que se llegue desde esta pantalla.
 */

import Link from "next/link";

import { signInSso, signOut } from "@/app/login/actions";
import { PistaDelOtroAmbiente } from "@/app/login/PistaDelOtroAmbiente";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRowOrThrow } from "@/lib/auth/user-row";
import { casillaDeGmail } from "@/lib/email/reserved";
import { getT, type ClaveDelServidor, type Locale } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { ultimoValor } from "@/lib/ultimo-valor";
import { abrirInvitacion, leerCookieDeInvitacion, resumenDeInvitacion } from "@/server/alta/invitacion";
import { urlDelOtroAmbiente } from "@/server/ambiente/de-otro-ambiente";

import { aceptarConClave, aceptarConGoogle, aceptarConSesion, rechazarInvitacion } from "./actions";

export const metadata = {
  title: "Invitación — ClaimMix",
  referrer: "no-referrer",
} as const;

const CLASE_DEL_CAMPO =
  "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-500/15 dark:border-slate-600 dark:placeholder-slate-500";

const CLASE_DE_LA_ETIQUETA = "mb-1.5 block text-sm font-medium text-slate-700";

const CLASE_DEL_BOTON_PRINCIPAL =
  "w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30";

const CLASE_DEL_BOTON_SECUNDARIO =
  "w-full rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/25 dark:border-slate-600";

const ERRORES: Record<string, ClaveDelServidor> = {
  clave: "alta.correo.error.clave",
  distintas: "alta.correo.error.distintas",
  intentos: "login.errores.demasiados_intentos",
  falla: "alta.correo.error.falla",
};

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

function Rechazar({ enlace, etiqueta }: { enlace: string; etiqueta: string }) {
  return (
    <form action={rechazarInvitacion} className="mt-3">
      <input type="hidden" name="t" value={enlace} />
      <button type="submit" className={CLASE_DEL_BOTON_SECUNDARIO}>
        {etiqueta}
      </button>
    </form>
  );
}

export default async function InvitacionPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[]; e?: string | string[] }>;
}) {
  const { t: crudo, e } = await searchParams;
  const locale = await getServerLocale();
  const t = getT(locale);

  if (ultimoValor(e) === "rechazada") {
    return (
      <Tarjeta titulo={t("invitacion.rechazada.titulo")} locale={locale}>
        <p className="text-sm text-slate-600">{t("invitacion.rechazada.texto")}</p>
      </Tarjeta>
    );
  }

  const enlace = ultimoValor(crudo) ?? (await leerCookieDeInvitacion());
  const datos = abrirInvitacion(enlace);
  // Una falla de la base tira y muestra la pantalla de error: nunca se confunde con «vencida».
  const resumen = datos && enlace ? await resumenDeInvitacion(datos) : null;

  if (!datos || !enlace || !resumen) {
    const otroAmbiente = urlDelOtroAmbiente("/login");
    return (
      <Tarjeta titulo={t("invitacion.vencida.titulo")} locale={locale}>
        <p className="text-sm text-slate-600">{t("invitacion.vencida.texto")}</p>
        {otroAmbiente && (
          <PistaDelOtroAmbiente texto={t("login.otroAmbiente")} url={otroAmbiente} className="mt-3 text-sm text-slate-600" />
        )}
      </Tarjeta>
    );
  }

  const usuario = (await getSessionContext())?.user;
  const esLaInvitada = usuario?.email.trim().toLowerCase() === datos.e;

  if (usuario && !esLaInvitada) {
    return (
      <Tarjeta titulo={t("invitacion.otraCuenta.titulo")} locale={locale}>
        <p className="mb-4 text-sm text-slate-600">{t("invitacion.otraCuenta.texto")}</p>
        <form action={signOut}>
          <button type="submit" className={CLASE_DEL_BOTON_SECUNDARIO}>
            {t("alta.salir")}
          </button>
        </form>
      </Tarjeta>
    );
  }
  if (usuario && (await getUserRowOrThrow(usuario.id))) {
    return (
      <Tarjeta titulo={t("invitacion.yaTenes.titulo")} locale={locale}>
        <p className="mb-4 text-sm text-slate-600">{t("invitacion.yaTenes.texto")}</p>
        <Link href="/bandeja" className="text-sm font-medium text-slate-800 underline underline-offset-2">
          {t("invitacion.yaTenes.ir")}
        </Link>
      </Tarjeta>
    );
  }

  if (resumen.exigeSso) {
    return (
      <Tarjeta titulo={t("invitacion.sso.titulo")} locale={locale}>
        <p className="mb-4 text-sm text-slate-600">{t("invitacion.sso.texto").replace("{espacio}", resumen.espacio)}</p>
        <form action={signInSso}>
          <input type="hidden" name="email" value={datos.e} />
          <button type="submit" className={CLASE_DEL_BOTON_PRINCIPAL}>
            {t("invitacion.sso.boton")}
          </button>
        </form>
        <Rechazar enlace={enlace} etiqueta={t("invitacion.rechazar")} />
      </Tarjeta>
    );
  }

  const motivo = ultimoValor(e);
  const claveError = motivo !== undefined && Object.hasOwn(ERRORES, motivo) ? ERRORES[motivo] : null;
  const conSesion = usuario !== undefined && usuario.emailVerified === true;
  const casilla = casillaDeGmail(datos.e);
  const conGoogle = casilla === null || casilla === datos.e.trim().toLowerCase();

  return (
    <Tarjeta titulo={t("invitacion.titulo")} locale={locale}>
      <p className="mb-1 text-sm font-medium text-slate-800">
        {t("invitacion.invito").replace("{quien}", resumen.quien).replace("{espacio}", resumen.espacio)}
      </p>
      <p className="mb-1 text-sm text-slate-600">{t("invitacion.para").replace("{correo}", datos.e)}</p>
      <p className="mb-4 text-sm text-slate-600">{t("invitacion.ayuda")}</p>

      {claveError && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
        >
          {t(claveError)}
        </div>
      )}

      {conSesion ? (
        <form action={aceptarConSesion}>
          <input type="hidden" name="t" value={enlace} />
          <button type="submit" className={CLASE_DEL_BOTON_PRINCIPAL}>
            {t("invitacion.aceptar")}
          </button>
        </form>
      ) : (
        <div className="space-y-4">
          {conGoogle && (
            <>
              <form action={aceptarConGoogle}>
                <input type="hidden" name="t" value={enlace} />
                <button type="submit" className={CLASE_DEL_BOTON_SECUNDARIO}>
                  {t("invitacion.google")}
                </button>
              </form>

              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span className="h-px flex-1 bg-slate-200" />
                <span className="uppercase tracking-[0.08em]">{t("invitacion.o")}</span>
                <span className="h-px flex-1 bg-slate-200" />
              </div>
            </>
          )}

          <form action={aceptarConClave} className="space-y-4">
            <input type="hidden" name="t" value={enlace} />
            <div>
              <label htmlFor="invitacion-clave" className={CLASE_DE_LA_ETIQUETA}>
                {t("invitacion.clave")}
              </label>
              <input
                id="invitacion-clave"
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
              <label htmlFor="invitacion-repetir" className={CLASE_DE_LA_ETIQUETA}>
                {t("invitacion.repetir")}
              </label>
              <input
                id="invitacion-repetir"
                name="repetir"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                className={CLASE_DEL_CAMPO}
              />
            </div>
            <button type="submit" className={CLASE_DEL_BOTON_PRINCIPAL}>
              {t("invitacion.aceptarClave")}
            </button>
          </form>
        </div>
      )}

      <Rechazar enlace={enlace} etiqueta={t("invitacion.rechazar")} />
    </Tarjeta>
  );
}
