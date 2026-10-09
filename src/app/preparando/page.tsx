/**
 * /preparando — la espera mientras se arma la base del espacio.
 *
 * Con una base por cliente, quien se acaba de dar de alta no puede entrar al
 * panel hasta que su base esté lista, y el layout de `(app)` manda acá a cualquiera
 * cuya base no lo esté. Vive fuera de `(app)` por eso, y el proxy la trata como
 * cualquier ruta privada. Apagada la bandera no tiene nada que mostrar.
 *
 * Qué se muestra, según `vistaDeBase`: lista, redirige (a la bandeja si ya tiene
 * conectados el WhatsApp y el correo, y si no a los primeros pasos de la
 * configuración); esperando, el aviso y un refresco cada 5 s; reintentable, el
 * botón que vuelve a lanzar la preparación (y el refresco, que la ve arrancar); y
 * dada de baja, un texto. Lee la fila sin la copia en memoria: acá se espera justo
 * a que el estado cambie.
 *
 * En un espacio del alta automática con el número por código prendido, su admin
 * conecta su WhatsApp mientras espera, con el mismo panel de /configuracion: el número
 * vive en control y no necesita la base del cliente. `?wa=` trae lo que dijo la última
 * acción. Quien no administra no ve el panel ni se consulta el número.
 */

import { redirect } from "next/navigation";

import { Tarjeta } from "@/app/alta/Tarjeta";
import { NumeroPanel } from "@/app/(app)/configuracion/NumeroPanel";
import { basePorCliente } from "@/data/bases";
import { filaDeUsuario, olvidarFilaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { getSessionContext } from "@/lib/auth/session";
import { getT } from "@/lib/i18n";
import { resolveAccountLocale } from "@/lib/i18n/locale";
import { numeroPorConectar } from "@/server/alta/numero-automatico";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import { esResultadoDelNumero, panelDelNumero } from "@/server/alta/numero-resultados";
import { destinoAlTerminarLaBase, pasosHechos } from "@/server/alta/pasos-hechos";
import { vistaDeBase } from "@/server/bases/espera";

import { reintentarMiBase } from "./actions";
import { Refrescar } from "./Refrescar";

export const metadata = { title: "Preparando tu espacio — ClaimMix" };

export default async function PreparandoPage({
  searchParams,
}: {
  searchParams: Promise<{ wa?: string | string[] }>;
}) {
  const usuario = (await getSessionContext())?.user;
  if (!usuario) redirect("/login");
  if (!basePorCliente()) redirect("/bandeja");
  const { wa } = await searchParams;

  olvidarFilaDeUsuario(usuario.id);
  const fila = await filaDeUsuario(usuario.id);
  if (!fila) redirect("/pendiente");

  const vista = vistaDeBase(fila);
  if (vista === "lista") {
    redirect(destinoAlTerminarLaBase(await pasosHechos(fila.tenant_id), esResultadoDelNumero(wa) ? wa : null));
  }

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

  // Sólo para quien puede conectar el número por código (admin de un espacio del alta automática); sin eso no se consulta nada más.
  const automatico = (ADMIN_ROLES as string[]).includes(fila.role) && fila.autoalta === true && numeroAutomatico();
  const panel = panelDelNumero(automatico, automatico && (await numeroPorConectar(fila.tenant_id)), wa);
  const numero = panel && (
    <>
      {panel.formularios && <p className="mt-5 text-sm font-medium text-slate-700">{t("preparando.whatsapp")}</p>}
      <NumeroPanel t={t} resultado={panel.resultado} formularios={panel.formularios} />
    </>
  );

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
        {numero}
        <Refrescar />
      </Tarjeta>
    );
  }

  return (
    <Tarjeta titulo={t("preparando.titulo")} locale={locale} etiquetaSalir={salir}>
      <p role="status" className="text-sm text-slate-600">
        {t("preparando.texto")}
      </p>
      {numero}
      <Refrescar />
    </Tarjeta>
  );
}
