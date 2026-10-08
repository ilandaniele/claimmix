import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";

import { CAMPO as CAMPO_BASE, ETIQUETA } from "@/components/estilos-de-formulario";
import { patronHtml } from "@/components/patron-html";
import { PATRON_DE_CORREO, PATRON_DE_NOMBRE, PATRON_DE_TELEFONO } from "@/core/web/formulario";
import { getT, type Locale } from "@/lib/i18n";
import { esSlugDeOtroAmbiente, urlDelOtroAmbiente } from "@/server/ambiente/de-otro-ambiente";
import { codigoPg } from "@/server/core-sync/config";
import { inquilinoDelFormulario } from "@/server/web/formulario";
import { firmarToken } from "@/server/web/token";

// El token lleva la hora en que se pintó la página: nunca puede salir de una copia prerenderizada.
export const dynamic = "force-dynamic";

/** La página no tiene sesión ni preferencia guardada: el idioma sale del navegador. */
async function idiomaDelNavegador(): Promise<Locale> {
  const preferido = (await headers()).get("accept-language")?.toLowerCase();
  return preferido?.startsWith("en") ? "en-US" : "es-AR";
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: getT(await idiomaDelNavegador())("denuncia.titulo"),
    robots: { index: false, follow: false },
  };
}

const CAMPO = `block w-full ${CAMPO_BASE}`;

export default async function DenunciaWebPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ r?: string | string[] }>;
}) {
  const { slug } = await params;
  // El formulario es de dev y el enlace viejo sigue impreso o embebido: de acá se va, sin mirar la base.
  const destino = esSlugDeOtroAmbiente(slug) ? urlDelOtroAmbiente(`/denuncia/${slug}`) : null;
  if (destino) permanentRedirect(destino);
  const { r } = await searchParams;
  const formulario = await inquilinoDelFormulario(slug).catch((e) => {
    // Sin la 0044 no hay formularios: la página no existe todavía.
    if (codigoPg(e) === "42P01") return null;
    throw e;
  });
  if (!formulario) notFound();

  const t = getT(await idiomaDelNavegador());

  // Lo que la ruta contestó, si esta carga viene de un envío. La página no lleva JavaScript: es el único aviso.
  const aviso =
    r === "enviada"
      ? {
          texto: t("denuncia.ok"),
          color: "border-emerald-300 bg-emerald-50 text-emerald-900",
        }
      : r === "limite"
        ? {
            texto: t("denuncia.limite"),
            color: "border-amber-300 bg-amber-50 text-amber-900",
          }
        : r === "invalida" || r === "error"
          ? {
              texto: t("denuncia.error"),
              color: "border-red-300 bg-red-50 text-red-900",
            }
          : null;

  return (
    <div className="lienzo min-h-screen px-4 py-10">
      <main className="mx-auto max-w-xl space-y-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {formulario.nombre}
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {t("denuncia.titulo")}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            {t("denuncia.introduccion")}
          </p>
        </div>

        {aviso && (
          <p
            role="status"
            className={`rounded-md border px-3 py-2 text-sm ${aviso.color}`}
          >
            {aviso.texto}
          </p>
        )}

        {r !== "enviada" && (
          <form
            method="post"
            action={`/api/denuncia/${slug}`}
            className="space-y-4"
          >
            <input type="hidden" name="t" value={firmarToken(slug)} />
            {/* El campo trampa: fuera de pantalla y fuera del foco, para que sólo lo llene un bot. */}
            <div
              aria-hidden="true"
              className="absolute -left-[9999px] h-0 w-0 overflow-hidden"
            >
              <label>
                Sitio web
                <input
                  type="text"
                  name="sitio"
                  tabIndex={-1}
                  autoComplete="off"
                />
              </label>
            </div>
            <label className={ETIQUETA}>
              {t("denuncia.nombre")}
              <input
                name="nombre"
                required
                minLength={2}
                maxLength={80}
                pattern={patronHtml(PATRON_DE_NOMBRE)}
                title={t("denuncia.nombreFormato")}
                autoComplete="name"
                className={CAMPO}
              />
            </label>
            <label className={ETIQUETA}>
              {t("denuncia.email")}
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                pattern={patronHtml(PATRON_DE_CORREO)}
                title={t("denuncia.emailFormato")}
                autoComplete="email"
                className={CAMPO}
              />
            </label>
            <label className={ETIQUETA}>
              {t("denuncia.telefono")}
              <input
                name="telefono"
                type="tel"
                maxLength={40}
                pattern={patronHtml(PATRON_DE_TELEFONO)}
                title={t("denuncia.telefonoFormato")}
                autoComplete="tel"
                className={CAMPO}
              />
            </label>
            <label className={ETIQUETA}>
              {t("denuncia.relato")}
              <textarea
                name="relato"
                required
                minLength={10}
                maxLength={5000}
                rows={7}
                className={CAMPO}
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
            >
              {t("denuncia.enviar")}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
