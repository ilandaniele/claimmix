/**
 * El resumen de ayer, arriba del todo de /metricas.
 *
 * Server component sin estado: los números ya vienen calculados desde
 * `consultaDeAyer`, así que acá sólo se dibujan. No es Pro y no manda ningún
 * correo — es sólo para mirar.
 */

import type { ResumenDeAyer as ResumenDeAyerData } from "@/server/metrics/kpis";
import { getT, type Locale, type TranslationKey } from "@/lib/i18n";

const TILE = "rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/70";
const LABEL = "text-xs text-slate-500";
const VALUE = "mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100";

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className={TILE}>
      <p className={LABEL}>{label}</p>
      <p className={VALUE}>{value}</p>
    </div>
  );
}

const TILES_AYER: Array<{ campo: keyof ResumenDeAyerData; rotulo: TranslationKey }> = [
  { campo: "reclamos", rotulo: "metricas.actividad.reclamos" },
  { campo: "whatsapps", rotulo: "metricas.actividad.whatsapps" },
  { campo: "mails", rotulo: "metricas.actividad.mails" },
  { campo: "escalados", rotulo: "metricas.card.escalados" },
  { campo: "cerrados", rotulo: "tabs.cerrado" },
];

const TILES_AHORA: Array<{ campo: keyof ResumenDeAyerData; rotulo: TranslationKey }> = [
  { campo: "para_responder", rotulo: "bandeja.paraResponder" },
  { campo: "confirmacion_pendiente", rotulo: "status.confirmacion_pendiente" },
];

export function ResumenDeAyer({
  resumen,
  locale,
}: {
  resumen: ResumenDeAyerData;
  locale: Locale;
}) {
  const t = getT(locale);

  return (
    <section data-testid="resumen-de-ayer" aria-labelledby="resumen-de-ayer-titulo">
      <h2 id="resumen-de-ayer-titulo" className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-100">
        {t("metricas.ayer.titulo")}
      </h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {TILES_AYER.map(({ campo, rotulo }) => (
          <Tile key={campo} label={t(rotulo)} value={resumen[campo]} />
        ))}
      </div>
      <h3 className="mb-3 mt-6 text-sm font-semibold text-slate-700 dark:text-slate-100">
        {t("metricas.ayer.ahora")}
      </h3>
      <div className="grid grid-cols-2 gap-4">
        {TILES_AHORA.map(({ campo, rotulo }) => (
          <Tile key={campo} label={t(rotulo)} value={resumen[campo]} />
        ))}
      </div>
    </section>
  );
}
