/**
 * /legal/[slug]/[pagina] — los términos, la privacidad y el borrado de datos de un
 * cliente que conecta WhatsApp con su propia app de Meta.
 *
 * Meta pide tres direcciones públicas por app y las lee cualquiera sin cuenta, así
 * que viven fuera de `(app)` y el proxy las deja pasar (con `X-Robots-Tag: noindex`).
 * Cada cliente tiene las suyas, con su razón social, su CUIT y su contacto; el
 * identificador del espacio nunca se muestra: la dirección sale del `slug_legal`, un
 * texto al azar que no dice de quién es.
 *
 * Los textos son un borrador a revisar por un abogado (ver docs/whatsapp-setup.md).
 * Un slug que no existe, una página que no es una de las tres o un cliente que todavía
 * no cargó sus datos dan 404: de afuera se ve igual que cualquier dirección inventada.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getT, type TranslationKey } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { datosLegalesDelSlug } from "@/server/whatsapp/numeros";

export const metadata: Metadata = {
  title: "Legal",
  robots: { index: false, follow: false },
};

const SLUG = /^[a-z0-9]{16}$/;

/** Cuántas secciones tiene cada página; los textos son `legal.<pagina>.s<n>.titulo` y `.texto`. */
const SECCIONES = { terminos: 5, privacidad: 5, borrado: 3 } as const;
type Pagina = keyof typeof SECCIONES;
const PAGINAS = Object.keys(SECCIONES) as Pagina[];

const esPagina = (valor: string): valor is Pagina => Object.hasOwn(SECCIONES, valor);

export default async function PaginaLegal({ params }: { params: Promise<{ slug: string; pagina: string }> }) {
  const { slug, pagina } = await params;
  if (!SLUG.test(slug) || !esPagina(pagina)) notFound();
  const datos = await datosLegalesDelSlug(slug);
  if (!datos) notFound();

  const t = getT(await getServerLocale());
  const clave = (k: string) => t(k as TranslationKey);
  const contacto = datos.contacto ?? t("legal.contactoSin");
  const rellenar = (texto: string) =>
    texto.replaceAll("{razonSocial}", datos.razonSocial).replaceAll("{cuit}", datos.cuit).replaceAll("{contacto}", contacto);

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16">
        <nav aria-label="Legal" className="mb-8 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {PAGINAS.map((p) =>
            p === pagina ? (
              <span key={p} aria-current="page" className="font-semibold text-slate-900">
                {clave(`legal.nav.${p}`)}
              </span>
            ) : (
              <a key={p} href={`/legal/${slug}/${p}`} className="text-indigo-600 hover:underline">
                {clave(`legal.nav.${p}`)}
              </a>
            )
          )}
        </nav>

        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{clave(`legal.${pagina}.titulo`)}</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-700">{rellenar(clave(`legal.${pagina}.intro`))}</p>

        <div className="mt-8 space-y-6 text-sm leading-relaxed text-slate-700">
          {Array.from({ length: SECCIONES[pagina] }, (_, i) => i + 1).map((n) => (
            <section key={n}>
              <h2 className="text-lg font-semibold text-slate-900">{clave(`legal.${pagina}.s${n}.titulo`)}</h2>
              <p className="mt-1">{rellenar(clave(`legal.${pagina}.s${n}.texto`))}</p>
            </section>
          ))}
        </div>

        <p className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-500">
          {t("legal.responsable").replace("{razonSocial}", datos.razonSocial).replace("{cuit}", datos.cuit)}
        </p>
      </div>
    </div>
  );
}
