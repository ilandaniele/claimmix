/**
 * Agenda page — Server Component.
 *
 * G39: los vencimientos ya salen de datos existentes —la ventana de 24 h de
 * WhatsApp, el cierre por abandono y, desde B10, el plazo de cada caso— y acá
 * se juntan en una sola lista, de sólo lectura, agrupada en Hoy / Mañana / por
 * fecha y paginada (`?page=`, `?per_page=`, validados con `camposDePagina`).
 *
 * D-D1: la abre cualquier rol. `leerAgenda` ya tapa el titular con `OCULTO`
 * para quien no está en `CUSTOMER_PII_ROLES`; esta página no vuelve a decidir
 * nada de eso, sólo dibuja lo que recibe.
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { getSessionContext } from "@/lib/auth/session";
import { getUserRow } from "@/lib/auth/user-row";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";
import { getT, type TranslationKey } from "@/lib/i18n";
import { diaArgentino } from "@/core/fecha/dia-argentino";
import { formatDate, formatDateOnly } from "@/lib/utils";
import {
  leerAgenda,
  PaginaDeAgendaSchema,
  type Vencimiento,
  type TipoDeVencimiento,
} from "@/server/cases/agenda";
import { Card } from "../_components/ui";
import { tituloDePantalla } from "@/app/(app)/_components/titulo-de-pantalla";

const TIPO_LABEL: Record<TipoDeVencimiento, TranslationKey> = {
  ventana_whatsapp: "agenda.tipo.ventanaWhatsapp",
  cierre_por_abandono: "agenda.tipo.cierreAbandono",
  plazo: "agenda.tipo.plazo",
};

interface AgendaPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

interface Grupo {
  etiqueta: string;
  items: Vencimiento[];
}

/**
 * Agrupa en Hoy / Mañana / por fecha, en el orden en que aparecen.
 *
 * `vencimientos` ya llega ordenado ascendente por `vence` — acá sólo se
 * reparte, no se reordena.
 */
function agrupar(
  vencimientos: Vencimiento[],
  ahora: Date,
  locale: Parameters<typeof formatDateOnly>[1],
  t: (key: TranslationKey) => string
): Grupo[] {
  const hoy = diaArgentino(ahora);
  const manana = diaArgentino(new Date(ahora.getTime() + 24 * 60 * 60 * 1000));
  const grupos = new Map<string, Grupo>();

  for (const v of vencimientos) {
    const dia = diaArgentino(new Date(v.vence));
    const etiqueta =
      dia === hoy ? t("agenda.hoy") : dia === manana ? t("agenda.manana") : formatDateOnly(dia, locale);
    const grupo = grupos.get(dia) ?? { etiqueta, items: [] };
    grupo.items.push(v);
    grupos.set(dia, grupo);
  }

  return [...grupos.values()];
}

export const generateMetadata = tituloDePantalla("nav.agenda");

export default async function AgendaPage({ searchParams }: AgendaPageProps) {
  const session = await getSessionContext();
  if (!session?.user) redirect("/login");
  // Deduplicada con la del layout: ver lib/auth/user-row.ts.
  const userRow = await getUserRow(session.user.id);
  if (!userRow) redirect("/pendiente");

  const locale = await getAccountLocale();
  const t = getT(locale);
  const ahora = new Date();

  // Una página que no se entiende (`?page=abc`) es la primera, no un error.
  const params = await searchParams;
  const pedida = PaginaDeAgendaSchema.safeParse({ page: params["page"], per_page: params["per_page"] });
  const { data: vencimientos, meta } = await leerAgenda(
    { tenantId: userRow.tenant_id },
    ahora,
    userRow.role,
    pedida.success ? pedida.data : {}
  );
  const grupos = agrupar(vencimientos, ahora, locale, t);
  const hrefDePagina = (page: number) =>
    `/agenda?${new URLSearchParams({ page: String(page), per_page: String(meta.per_page) }).toString()}`;

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pb-5 pt-1">
        <h1 className="text-balance text-[26px] font-semibold tracking-tight text-slate-900">
          {t("agenda.title")}
        </h1>
        <p className="mt-1 text-[13px] text-slate-500">{t("agenda.subtitle")}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-8">
        <Card className="flex flex-col divide-y divide-slate-100">
          {grupos.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-slate-500">{t("agenda.empty")}</p>
          ) : (
            grupos.map((grupo) => (
              <div key={grupo.etiqueta} className="px-5 py-4">
                <p className="rotulo mb-2 text-slate-500">{grupo.etiqueta}</p>
                <div className="space-y-2">
                  {grupo.items.map((v) => (
                    <Link
                      key={v.caseId}
                      href={`/casos/${v.caseId}`}
                      className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 hover:bg-slate-50"
                    >
                      <span className="flex flex-col">
                        <span className="text-[13.5px] font-medium text-slate-900">
                          {v.titular ?? (
                            <span className="text-slate-300" aria-label={t("vacio.sinDato")}>—</span>
                          )}{" "}
                          — {v.numero}
                        </span>
                        <span className="text-[12px] text-slate-500">{t(TIPO_LABEL[v.tipo])}</span>
                      </span>
                      <span className="whitespace-nowrap text-[12.5px] text-slate-500">
                        {formatDate(v.vence, locale)}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ))
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
