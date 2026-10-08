/**
 * /alta — donde la persona crea su espacio.
 *
 * Es el destino de Google (`newUserCallbackURL`) y de quien, con la cuenta ya
 * hecha, todavía no tiene perfil: /pendiente la manda acá. Exige sesión y NO
 * exige perfil, así que vive fuera de `(app)`. El proxy la trata como cualquier
 * ruta privada: no está en PUBLIC_PREFIXES ni en SOLO_ANONIMOS.
 *
 * Es un componente de servidor y un formulario de servidor: funciona sin
 * JavaScript. Con la cookie `cm_alta` el formulario llega precargado y un script
 * de una línea, con el nonce del CSP, lo envía solo; sin script queda el botón.
 * La cookie sólo precarga: lo que se crea es lo que dice el formulario.
 *
 * La cookie es del navegador y no de la cuenta. El envío solo y los términos
 * tildados valen únicamente si la persona llega por el viaje a Google que dejó la
 * cookie (`?v=` igual al de la cookie); si no, la precarga queda y el resto lo
 * hace la persona: en un navegador compartido no se crea un espacio con datos ajenos.
 *
 * Qué se muestra, en orden: con perfil va a /bandeja; sin el correo verificado,
 * «revisá tu correo»; una dirección de operación no crea espacios; con el alta
 * cerrada para la dirección, el texto neutro; y si no, el formulario, con un
 * texto fijo debajo para quien llega de una empresa que ya usa ClaimMix: se
 * entra por invitación, no se busca a la empresa por el dominio del correo.
 */

import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { signOut } from "@/app/login/actions";
import { altaAbierta } from "@/lib/auth/registro-permitido";
import { isOperatorEmail } from "@/lib/auth/require-operator";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRowOrThrow } from "@/lib/auth/user-row";
import { getT, type ClaveDelServidor, type Locale } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { leerCookieDeAlta, PARAMETRO_DE_VUELTA } from "@/server/alta/cookie";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import { ERRORES_DE_ALTA, type ErrorDeAlta } from "@/server/alta/validar";

import { crearMiEspacio } from "./actions";

export const metadata = { title: "Crear mi espacio — ClaimMix" };

const ENVIO_AUTOMATICO = 'document.getElementById("alta-form").requestSubmit()';

const CLASE_DEL_CAMPO =
  "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-500/15 dark:border-slate-600 dark:placeholder-slate-500";

const ultimo = (v: string | string[] | undefined) => (Array.isArray(v) ? v.at(-1) : v);

/** La clave del texto de un motivo; uno que no está en la lista no muestra nada. */
function claveDelError(e: string | string[] | undefined): ClaveDelServidor | null {
  const motivo = Array.isArray(e) ? e.at(-1) : e;
  return (ERRORES_DE_ALTA as readonly string[]).includes(motivo ?? "")
    ? (`alta.error.${motivo as ErrorDeAlta}` as const)
    : null;
}

function Tarjeta({
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
        <form action={signOut} className="mt-5 text-center">
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

export default async function AltaPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string | string[]; [PARAMETRO_DE_VUELTA]?: string | string[] }>;
}) {
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
  if (!altaAbierta(usuario.email)) {
    return (
      <Tarjeta titulo={t("alta.cerrada.titulo")} locale={locale} etiquetaSalir={salir}>
        <p className="text-sm text-slate-600">{t("alta.cerrada.texto")}</p>
      </Tarjeta>
    );
  }

  const consulta = await searchParams;
  const claveError = claveDelError(consulta.e);
  const datos = await leerCookieDeAlta();
  const esDeEstaSesion = datos !== null && ultimo(consulta[PARAMETRO_DE_VUELTA]) === datos.v;
  // Tras un error no se reenvía solo: sería el mismo pedido otra vez.
  const envioAutomatico = esDeEstaSesion && claveError === null;
  const nonce = (await headers()).get("x-csp-nonce") ?? undefined;

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

      <form id="alta-form" action={crearMiEspacio} className="space-y-4">
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
            defaultValue={datos?.empresa}
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
            placeholder="+54 9 …"
            aria-describedby="alta-whatsapp-ayuda"
            defaultValue={datos?.numero}
            className={CLASE_DEL_CAMPO}
          />
          <p id="alta-whatsapp-ayuda" className="mt-1.5 text-xs text-slate-500">
            {t("alta.whatsapp.ayuda")}
            {numeroAutomatico() ? ` ${t("alta.whatsapp.aviso")}` : null}
          </p>
        </div>
        <label className="flex items-start gap-2.5 text-sm text-slate-600">
          <input
            type="checkbox"
            name="terminos"
            required
            defaultChecked={esDeEstaSesion}
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

      <p className="mt-4 text-center text-xs text-slate-500">{t("alta.yaUsaClaimMix")}</p>

      {envioAutomatico && <script nonce={nonce} dangerouslySetInnerHTML={{ __html: ENVIO_AUTOMATICO }} />}
    </Tarjeta>
  );
}
