/**
 * La carta con que un tercero reclama al asegurado, leída para el equipo (B24).
 *
 * Componente de servidor: la lectura, lo que falta y el cotejo con la historia
 * clínica se calculan en `cargarDetalleDeCaso`; acá sólo se pinta. Lo que dice
 * la carta va sin verificar, y nada de esto —ni los montos ni quién reclama—
 * le llega al asegurado. La identidad del reclamante es de quien ve el padrón.
 */

import type { CartaEnPantalla } from "@/server/cases/detail-view";
import type { ReclamoTercero } from "@/core/case/reclamo-tercero";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { formatArs, formatDateOnly, formatUsd } from "@/lib/utils";
import { Field, FieldGrid } from "@/app/(app)/_components/ui";

type Traductor = (key: TranslationKey) => string;

const importe = (n: number, moneda: ReclamoTercero["moneda"]) => (moneda === "USD" ? formatUsd(n) : formatArs(n));

function Carta({
  carta,
  t,
  locale,
  puedeVerReclamante,
}: {
  carta: CartaEnPantalla;
  t: Traductor;
  locale: Locale;
  puedeVerReclamante: boolean;
}) {
  const { reclamo } = carta;
  if (!reclamo) {
    return (
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-slate-700 dark:text-slate-300">{carta.filename}</p>
        <p className="text-[12px] text-amber-700 dark:text-amber-300">
          {carta.sinLeer ? t(`lectura.sinLeer.${carta.sinLeer}`) : t("reclamo.sinLeer")}
        </p>
      </div>
    );
  }
  const { reclamante } = reclamo;
  return (
    <div className="space-y-3">
      <p className="text-[13px] font-medium text-slate-700 dark:text-slate-300">{carta.filename}</p>
      <FieldGrid>
        {puedeVerReclamante && (
          <>
            <Field label={t("reclamo.reclamante")}>{reclamante.nombre}</Field>
            <Field label={t("reclamo.patente")}>{reclamante.patente}</Field>
            <Field label={t("reclamo.letrado")}>{reclamante.letrado}</Field>
          </>
        )}
        <Field label={t("reclamo.aseguradora")}>{reclamante.aseguradora}</Field>
        <Field label={t("reclamo.fecha")}>{reclamo.fecha_carta ? formatDateOnly(reclamo.fecha_carta, locale) : null}</Field>
        <Field label={t("reclamo.plazo")}>
          {reclamo.plazo_dias === null ? null : t("reclamo.plazoDias").replace("{n}", String(reclamo.plazo_dias))}
        </Field>
        <Field label={t("reclamo.total")}>{carta.total === null ? null : importe(carta.total, reclamo.moneda)}</Field>
      </FieldGrid>
      {!puedeVerReclamante && <p className="text-[12px] text-slate-500 dark:text-slate-400">{t("reclamo.reservado")}</p>}
      {reclamo.rubros.length > 0 && (
        <div>
          <p className="rotulo text-slate-500">{t("reclamo.rubros")}</p>
          <ul className="mt-1 space-y-1 text-sm text-slate-700 dark:text-slate-300">
            {reclamo.rubros.map((r, i) => (
              <li key={`${r.rubro}-${i}`}>
                · {t(`reclamo.rubro.${r.rubro}`)}:{" "}
                {r.monto === null ? t("reclamo.sinMonto") : <span className="font-mono">{importe(r.monto, reclamo.moneda)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {reclamo.adjunta.length > 0 && (
        <p className="text-sm text-slate-700 dark:text-slate-300">
          <span className="rotulo text-slate-500">{t("reclamo.adjunta")}: </span>
          {reclamo.adjunta.map((a) => t(`reclamo.adjunta.${a}`)).join(", ")}
        </p>
      )}
      {carta.faltantes.length > 0 && (
        <div>
          <p className="rotulo text-slate-500">{t("reclamo.faltantes")}</p>
          <ul className="mt-1 space-y-1 text-sm text-amber-800 dark:text-amber-300">
            {carta.faltantes.map((f) => (
              <li key={f}>· {t(`reclamo.faltante.${f}` as TranslationKey)}</li>
            ))}
          </ul>
        </div>
      )}
      {carta.cruces.length > 0 && (
        <div>
          <p className="rotulo text-slate-500">{t("reclamo.cruces")}</p>
          <ul className="mt-1 space-y-1 text-sm text-amber-800 dark:text-amber-300">
            {carta.cruces.map((c) => (
              <li key={c}>· {t(`reclamo.cruce.${c}`)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ReclamoTerceroPanel({
  cartas,
  t,
  locale,
  puedeVerReclamante,
}: {
  cartas: CartaEnPantalla[];
  t: Traductor;
  locale: Locale;
  puedeVerReclamante: boolean;
}) {
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-slate-500 dark:text-slate-400">{t("reclamo.aviso")}</p>
      {cartas.map((c) => (
        <Carta key={c.id} carta={c} t={t} locale={locale} puedeVerReclamante={puedeVerReclamante} />
      ))}
    </div>
  );
}
