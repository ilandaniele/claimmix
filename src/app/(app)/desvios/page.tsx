/**
 * Desvíos — Server Component (B22).
 *
 * Lo que la revisión de cada noche encontró fuera de lo esperado: un documento
 * que no llegó, un caso que cerró sin haber estado listo, una derivación sin
 * respuesta, un plazo vencido, un plan sin terminar. Cada fila abre el caso.
 *
 * Sólo para quien maneja al equipo (`REVISION_ROLES`); el resto vuelve a la
 * bandeja, como en «Clientes». La lista es de sólo lectura y paginada
 * (`?page=`, `?per_page=`, validados con `camposDePagina`).
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { HORAS_DERIVACION_SIN_RESPUESTA, HORAS_DOC_SIN_RECIBIR, type Regla } from "@/core/desvios/reglas";
import { REVISION_ROLES } from "@/lib/auth/roles";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRow } from "@/lib/auth/user-row";
import { getT, type Locale, type TranslationKey } from "@/lib/i18n";
import { formatDate } from "@/lib/utils";
import { type Desvio, etiquetaDeDocumento, listarDesvios, PaginaDeDesviosSchema } from "@/server/desvios/listar";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";
import { Card } from "../_components/ui";

const TEXTOS: Record<Regla, { titulo: TranslationKey; detalle: TranslationKey; horas?: number }> = {
  doc_sin_recibir: {
    titulo: "desvios.regla.docSinRecibir",
    detalle: "desvios.detalle.docSinRecibir",
    horas: HORAS_DOC_SIN_RECIBIR,
  },
  cierre_sin_listo: { titulo: "desvios.regla.cierreSinListo", detalle: "desvios.detalle.cierreSinListo" },
  derivacion_sin_respuesta: {
    titulo: "desvios.regla.derivacionSinRespuesta",
    detalle: "desvios.detalle.derivacionSinRespuesta",
    horas: HORAS_DERIVACION_SIN_RESPUESTA,
  },
  plazo_vencido: { titulo: "desvios.regla.plazoVencido", detalle: "desvios.detalle.plazoVencido" },
  plan_sin_terminar: { titulo: "desvios.regla.planSinTerminar", detalle: "desvios.detalle.planSinTerminar" },
};

interface DesviosPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * Una clave que guardó la regla, dicha como la ve una persona. Las claves de
 * fábrica se traducen con el diccionario; las que puso la aseguradora (un plazo
 * o un paso propios) no tienen de dónde, y quedan con la clave sin guiones.
 */
function etiquetaDelDato(
  desvio: Desvio,
  clave: string,
  locale: Locale,
  t: (key: TranslationKey) => string
): string {
  const sinGuiones = clave.replace(/_/g, " ");
  switch (desvio.regla) {
    case "doc_sin_recibir":
      return etiquetaDeDocumento(clave, desvio.tipo, locale, t);
    case "cierre_sin_listo":
      return t(`status.${clave}` as TranslationKey) || clave;
    case "plazo_vencido":
      return t(`plazo.${clave}` as TranslationKey) || sinGuiones;
    case "plan_sin_terminar":
      return t(`trabajo.paso.${clave}` as TranslationKey) || sinGuiones;
    default:
      return sinGuiones;
  }
}

export default async function DesviosPage({ searchParams }: DesviosPageProps) {
  const session = await getSessionContext();
  if (!session?.user) redirect("/login");
  // Deduplicada con la del layout: ver lib/auth/user-row.ts.
  const userRow = await getUserRow(session.user.id);
  if (!userRow) redirect("/pendiente");
  // Esconder el enlace no es una guarda: la guarda es esta.
  if (!(REVISION_ROLES as string[]).includes(userRow.role)) redirect("/bandeja");

  const locale = await getAccountLocale();
  const t = getT(locale);

  // Una página que no se entiende (`?page=abc`) es la primera, no un error.
  const params = await searchParams;
  const pedida = PaginaDeDesviosSchema.safeParse({ page: params["page"], per_page: params["per_page"] });
  const { data: desvios, meta } = await listarDesvios(
    { tenantId: userRow.tenant_id },
    userRow.role,
    pedida.success ? pedida.data : {}
  );
  const hrefDePagina = (page: number) =>
    `/desvios?${new URLSearchParams({ page: String(page), per_page: String(meta.per_page) }).toString()}`;

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pb-5 pt-1">
        <h1 className="text-balance text-[26px] font-semibold tracking-tight text-slate-900">
          {t("desvios.title")}
        </h1>
        <p className="mt-1 text-[13px] text-slate-500">{t("desvios.subtitle")}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-8">
        <Card className="flex flex-col divide-y divide-slate-100">
          {desvios.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-slate-500">{t("desvios.empty")}</p>
          ) : (
            <div className="space-y-2 px-5 py-4">
              {desvios.map((d) => {
                const textos = TEXTOS[d.regla as Regla];
                const datos = d.datos.map((c) => etiquetaDelDato(d, c, locale, t));
                return (
                  <Link
                    key={`${d.caseId}:${d.regla}:${d.ancla}`}
                    href={`/casos/${d.caseId}`}
                    className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 hover:bg-slate-50"
                  >
                    <span className="flex flex-col">
                      <span className="text-[13.5px] font-medium text-slate-900">
                        {d.titular ?? (
                          <span className="text-slate-300" aria-label={t("vacio.sinDato")}>—</span>
                        )}{" "}
                        — {d.numero}
                      </span>
                      <span className="text-[12.5px] text-slate-700">{textos ? t(textos.titulo) : d.regla}</span>
                      {textos && (
                        <span className="text-[12px] text-slate-500">
                          {t(textos.detalle).replace("{n}", String(textos.horas ?? ""))}
                          {datos.length > 0 && ` ${datos.join(", ")}.`}
                        </span>
                      )}
                    </span>
                    <span className="whitespace-nowrap text-[12.5px] text-slate-500">
                      {t("desvios.ocurrio")} {formatDate(d.ancla, locale)}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </Card>

        {meta.total > 0 && (
          <div className="flex items-center justify-between pt-4">
            <p className="text-[13px] text-slate-500">
              {Math.min((meta.page - 1) * meta.per_page + 1, meta.total)}–
              {Math.min(meta.page * meta.per_page, meta.total)} {t("pagination.of")} {meta.total}
            </p>
            <div className="flex items-center gap-2">
              {meta.page > 1 && (
                <Link
                  href={hrefDePagina(meta.page - 1)}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
                >
                  {t("pagination.previous")}
                </Link>
              )}
              <span className="text-sm text-slate-500">
                {meta.page} / {Math.max(1, meta.pages)}
              </span>
              {meta.page < meta.pages && (
                <Link
                  href={hrefDePagina(meta.page + 1)}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
                >
                  {t("pagination.next")}
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
