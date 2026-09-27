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

/** El período de hoy, según la unidad elegida. */
const ROTULO_ACTUAL: Record<Unidad, TranslationKey> = {
  dia: "metricas.resumen.hoy",
  mes: "metricas.resumen.esteMes",
  anio: "metricas.resumen.esteAnio",
};

/** La ventana entera, la misma que ya dibuja la lista de abajo. */
const ROTULO_VENTANA: Record<Unidad, TranslationKey> = {
  dia: "metricas.resumen.ultimos30dias",
  mes: "metricas.resumen.ultimos12meses",
  anio: "metricas.resumen.ultimos5anios",
};

const SIN_ACTIVIDAD: PuntoSerie = {
  clave: "",
  reclamos: 0,
  whatsapps: 0,
  mails: 0,
  reclamos_whatsapp: 0,
  reclamos_mail: 0,
};

/** La ventana entera sumada en un solo punto. */
function sumarVentana(serie: PuntoSerie[]): PuntoSerie {
  return serie.reduce(
    (acc, p) => ({
      clave: "",
      reclamos: acc.reclamos + p.reclamos,
      whatsapps: acc.whatsapps + p.whatsapps,
      mails: acc.mails + p.mails,
      reclamos_whatsapp: acc.reclamos_whatsapp + p.reclamos_whatsapp,
      reclamos_mail: acc.reclamos_mail + p.reclamos_mail,
    }),
    SIN_ACTIVIDAD
  );
}

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

/**
 * Una columna del resumen: el período (hoy, o la ventana entera) y sus tres
 * números. El mismo estilo de tile que ya usa la pantalla para el uso de IA.
 */
function ColumnaResumen({
  titulo,
  punto,
  t,
  testId,
}: {
  titulo: string;
  punto: PuntoSerie;
  t: (key: TranslationKey) => string;
  testId: string;
}) {
  const porCanal = t("metricas.resumen.porCanal")
    .replace("{whatsapp}", String(punto.reclamos_whatsapp))
    .replace("{mail}", String(punto.reclamos_mail));

  return (
    <div
      data-testid={testId}
      className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/70"
    >
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {titulo}
      </h3>
      <dl className="space-y-3">
        <div>
          <dt className="text-xs text-slate-600 dark:text-slate-300">
            {t("metricas.actividad.reclamos")}
          </dt>
          <dd className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
            {punto.reclamos}
          </dd>
          <p className="text-xs text-slate-500 dark:text-slate-400">{porCanal}</p>
        </div>
        <div>
          <dt className="text-xs text-slate-600 dark:text-slate-300">
            {t("metricas.actividad.whatsapps")}
          </dt>
          <dd className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
            {punto.whatsapps}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600 dark:text-slate-300">
            {t("metricas.actividad.mails")}
          </dt>
          <dd className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
            {punto.mails}
          </dd>
        </div>
      </dl>
    </div>
  );
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
  // El resumen de arriba: el último período de la ventana, y la ventana entera
  // sumada. `serie` siempre trae 30, 12 o 5 puntos —la rellena `completarSerie`—
  // pero el `?? SIN_ACTIVIDAD` cubre igual un array vacío.
  const actual = serie.at(-1) ?? SIN_ACTIVIDAD;
  const ventana = sumarVentana(serie);

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

      <div
        className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2"
        data-testid="resumen-actividad"
      >
        <ColumnaResumen
          titulo={t(ROTULO_ACTUAL[unidad])}
          punto={actual}
          t={t}
          testId="resumen-actual"
        />
        <ColumnaResumen
          titulo={t(ROTULO_VENTANA[unidad])}
          punto={ventana}
          t={t}
          testId="resumen-ventana"
        />
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
