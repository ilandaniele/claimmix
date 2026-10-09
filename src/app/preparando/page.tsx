/**
 * /preparando — la espera mientras se arma la base del espacio.
 *
 * Con una base por cliente, quien se acaba de dar de alta no puede entrar al
 * panel hasta que su base esté lista, y el layout de `(app)` manda acá a cualquiera
 * cuya base no lo esté. Vive fuera de `(app)` por eso, y el proxy la trata como
 * cualquier ruta privada. Apagada la bandera no tiene nada que mostrar.
 *
 * Qué se muestra, según `vistaDeBase`: lista, redirige a la configuración;
 * esperando, el aviso y un refresco cada 5 s; reintentable, el botón que vuelve a
 * lanzar la preparación (y el refresco, que la ve arrancar); y dada de baja, un texto.
 * Lee la fila sin la copia en memoria: acá se espera justo a que el estado cambie.
 */

import { redirect } from "next/navigation";

import { Tarjeta } from "@/app/alta/Tarjeta";
import { basePorCliente } from "@/data/bases";
import { filaDeUsuario, olvidarFilaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";
import { getSessionContext } from "@/lib/auth/session";
import { getT } from "@/lib/i18n";
import { resolveAccountLocale } from "@/lib/i18n/locale";
import { vistaDeBase } from "@/server/bases/espera";

import { reintentarMiBase } from "./actions";
import { Refrescar } from "./Refrescar";

export const metadata = { title: "Preparando tu espacio — ClaimMix" };

export default async function PreparandoPage() {
  const usuario = (await getSessionContext())?.user;
  if (!usuario) redirect("/login");
  if (!basePorCliente()) redirect("/bandeja");

  olvidarFilaDeUsuario(usuario.id);
  const fila = await filaDeUsuario(usuario.id);
  if (!fila) redirect("/pendiente");

  const vista = vistaDeBase(fila);
  if (vista === "lista") redirect("/configuracion?primeros=1");

  const locale = await resolveAccountLocale(fila.locale);
  const t = getT(locale);
  const salir = t("alta.salir");

  if (vista === "borrada") {
    return (
      <Tarjeta titulo={t("preparando.borrada.titulo")} locale={locale} etiquetaSalir={salir}>
        <p className="text-sm text-slate-600">{t("preparando.borrada.texto")}</p>
      </Tarjeta>
    );
  }

  if (vista === "reintentable") {
    return (
      <Tarjeta titulo={t("preparando.reintentable.titulo")} locale={locale} etiquetaSalir={salir}>
        <p className="mb-4 text-sm text-slate-600">{t("preparando.reintentable.texto")}</p>
        <form action={reintentarMiBase}>
          <button
            type="submit"
            className="w-full rounded-full bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30"
          >
            {t("preparando.reintentar")}
          </button>
        </form>
        <Refrescar />
      </Tarjeta>
    );
  }

  return (
    <Tarjeta titulo={t("preparando.titulo")} locale={locale} etiquetaSalir={salir}>
      <p role="status" className="text-sm text-slate-600">
        {t("preparando.texto")}
      </p>
      <Refrescar />
    </Tarjeta>
  );
}
