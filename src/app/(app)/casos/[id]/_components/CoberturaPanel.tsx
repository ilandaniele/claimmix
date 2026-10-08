/**
 * ¿La póliza cubre el siniestro, y cuánto cuesta más o menos? (B6, B23)
 *
 * Componente de servidor: el veredicto se calcula en `cargarDetalleDeCaso` y
 * acá sólo se pinta, rotulado como orientativo. Es para el equipo; al asegurado
 * no le llega nada de esto.
 */

import type { CoberturaEnPantalla } from "@/server/cases/detail-view";
import type { TranslationKey } from "@/lib/i18n";
import { formatArs } from "@/lib/utils";
import { Field, FieldGrid, Pill } from "@/app/(app)/_components/ui";

const TONO = { cubre: "listo", no_cubre: "critico", dudoso: "espera" } as const;

export function VeredictoDeCobertura({
  cobertura,
  t,
}: {
  cobertura: CoberturaEnPantalla;
  t: (key: TranslationKey) => string;
}) {
  const { veredicto } = cobertura.resultado;
  return <Pill tone={TONO[veredicto]}>{t(`cobertura.veredicto.${veredicto}`)}</Pill>;
}

export function CoberturaPanel({
  cobertura,
  t,
}: {
  cobertura: CoberturaEnPantalla;
  t: (key: TranslationKey) => string;
}) {
  const { resultado, condiciones, monto } = cobertura;
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-slate-500 dark:text-slate-400">{t("cobertura.orientativa")}</p>
      {condiciones !== "leidas" && (
        <p className="text-[12px] text-amber-700 dark:text-amber-300">{t(`cobertura.condiciones.${condiciones}`)}</p>
      )}
      {resultado.motivos.length > 0 && (
        <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300">
          {resultado.motivos.map((m) => (
            <li key={m}>· {t(`cobertura.motivo.${m}`)}</li>
          ))}
        </ul>
      )}
      <FieldGrid>
        <Field label={t("monto.titulo")}>
          {monto
            ? `${formatArs(monto.minimo)} – ${formatArs(monto.maximo)} · ${t(`monto.origen.${monto.origen}`)}`
            : null}
        </Field>
      </FieldGrid>
      <p className="text-[12px] text-slate-500 dark:text-slate-400">{t("monto.orientativo")}</p>
    </div>
  );
}
