/**
 * Reclamos abiertos, WhatsApps y mails atendidos por día, mes o año.
 *
 * Server component sin estado: la unidad viaja en `?serie=` y cambiarla es
 * navegar, así que no hace falta estado en el navegador. Lo único de cliente es
 * `EnCamino`, la señal mientras el servidor dibuja la unidad nueva.
 */

import Link from "next/link";
import { mesDeCalendario } from "@/core/fecha/mes-calendario";
import { UNIDADES, type PuntoSerie, type Unidad } from "@/core/metricas/serie";
import { getT, type Locale, type TranslationKey } from "@/lib/i18n";
import { anchoDeBarra } from "@/lib/ui/ancho-de-barra";
import { formatDateOnly } from "@/lib/utils";
import { EnCamino } from "./EnCamino";

const ROTULO_UNIDAD: Record<Unidad, TranslationKey> = {
  dia: "metricas.actividad.dia",
  mes: "metricas.actividad.mes",
  anio: "metricas.actividad.anio",
};

const SERIES: Array<{
  campo: "reclamos" | "whatsapps" | "mails";
  rotulo: TranslationKey;
  color: string;
}> = [
  { campo: "reclamos", rotulo: "metricas.actividad.reclamos", color: "bg-blue-500" },
  { campo: "whatsapps", rotulo: "metricas.actividad.whatsapps", color: "bg-green-500" },
  { campo: "mails", rotulo: "metricas.actividad.mails", color: "bg-purple-500" },
];

function rotuloDe(clave: string, unidad: Unidad, locale: Locale): string {
  if (unidad === "mes") return mesDeCalendario(clave, locale);
  if (unidad === "anio") return clave;
  return formatDateOnly(clave, locale);
}

export function SerieDeActividad({
  serie,
  unidad,
  locale,
}: {
  serie: PuntoSerie[];
  unidad: Unidad;
  locale: Locale;
}) {
  const t = getT(locale);
  // Una escala para las tres series: así una barra de WhatsApp y una de mail
  // del mismo largo son la misma cantidad.
  const max = Math.max(0, ...serie.flatMap((p) => SERIES.map((s) => p[s.campo])));

  return (
    <section
      data-testid="serie-actividad"
      className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/70"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-100">
            {t("metricas.actividad.titulo")}
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t("metricas.actividad.nota")}
          </p>
        </div>
        <nav className="flex gap-1">
          {UNIDADES.map((u) => (
            <Link
              key={u}
              href={`/metricas?serie=${u}`}
              // La serie está al final de la página: con el scroll por omisión,
              // Next vuelve al encabezado en cada cambio de unidad.
              scroll={false}
              aria-current={u === unidad ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                u === unidad
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {t(ROTULO_UNIDAD[u])}
              <EnCamino />
            </Link>
          ))}
        </nav>
      </div>

      <div className="mb-4 flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-300">
        {SERIES.map((s) => (
          <span key={s.campo} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${s.color}`} aria-hidden="true" />
            {t(s.rotulo)}
          </span>
        ))}
      </div>

      <ul className="space-y-2">
        {serie.map((p) => (
          <li key={p.clave} className="flex items-center gap-3">
            <span className="w-32 shrink-0 text-xs text-slate-600 dark:text-slate-300">
              {rotuloDe(p.clave, unidad, locale)}
            </span>
            <div className="flex-1 space-y-0.5">
              {SERIES.map((s) => (
                <div key={s.campo} className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      data-testid="barra"
                      aria-hidden="true"
                      className={`h-full rounded-full ${s.color} ${anchoDeBarra(
                        max ? (p[s.campo] / max) * 100 : 0
                      )}`}
                    />
                  </div>
                  <span className="w-8 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">
                    <span className="sr-only">{t(s.rotulo)}: </span>
                    {p[s.campo]}
                  </span>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
