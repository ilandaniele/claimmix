/**
 * La opinión preliminar de responsabilidad en un choque (B18).
 *
 * Componente de servidor: la opinión sale de `opinarResponsabilidad` y acá sólo
 * se pinta. Es orientativa y es para el equipo; al asegurado no le llega nada
 * de esto, y el agente nunca le dice quién tiene la culpa.
 */

import { REGLAS, type Regla, type Responsabilidad } from "@/core/case/responsabilidad";
import type { TranslationKey } from "@/lib/i18n";
import { Field, FieldGrid, Pill } from "@/app/(app)/_components/ui";

const TONO = { asegurado: "critico", tercero: "listo", compartida: "espera", no_determinable: "neutro" } as const;

const esRegla = (r: string): r is Regla => (REGLAS as readonly string[]).includes(r);

export function VeredictoDeResponsabilidad({
  responsabilidad,
  t,
}: {
  responsabilidad: Responsabilidad;
  t: (key: TranslationKey) => string;
}) {
  const { responsable } = responsabilidad;
  return <Pill tone={TONO[responsable]}>{t(`responsabilidad.responsable.${responsable}`)}</Pill>;
}

export function ResponsabilidadPanel({
  responsabilidad,
  t,
}: {
  responsabilidad: Responsabilidad;
  t: (key: TranslationKey) => string;
}) {
  const { regla, motivo, faltantes, difiere } = responsabilidad;
  const parte = motivo.params.parte;
  const nombreDeLaParte = parte === "asegurado" || parte === "tercero" ? t(`responsabilidad.parte.${parte}`) : "";
  // Con reglas que apuntan a partes distintas la opinión no cita una sola: las lista el motivo.
  const reglas = regla ? [regla] : (motivo.params.reglas ?? "").split(",").filter(esRegla);
  // Las claves vienen de la base: una que esta versión no sabe traducir no deja un renglón vacío.
  const pendientes = faltantes.map((f) => t(`responsabilidad.faltante.${f}` as TranslationKey)).filter(Boolean);

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-amber-700 dark:text-amber-300">{t("responsabilidad.orientativa")}</p>
      <FieldGrid>
        <Field label={t("responsabilidad.campo.responsable")}>
          {t(`responsabilidad.responsable.${responsabilidad.responsable}`)}
        </Field>
        <Field label={t("responsabilidad.campo.regla")}>
          {reglas.length > 0
            ? reglas.map((r) => <span key={r} className="block">{t(`responsabilidad.regla.${r}`)}</span>)
            : t("responsabilidad.regla.ninguna")}
        </Field>
      </FieldGrid>
      <p className="text-sm text-slate-700 dark:text-slate-300">
        {t(`responsabilidad.motivo.${motivo.clave}`).replace("{parte}", nombreDeLaParte)}
      </p>
      {pendientes.length > 0 && (
        <div>
          <p className="rotulo text-slate-500">{t("responsabilidad.faltantes")}</p>
          <ul className="mt-1 space-y-1 text-sm text-slate-700 dark:text-slate-300">
            {pendientes.map((texto) => (
              <li key={texto}>· {texto}</li>
            ))}
          </ul>
        </div>
      )}
      {difiere && <p className="text-[12px] text-amber-700 dark:text-amber-300">{t("responsabilidad.difiere")}</p>}
    </div>
  );
}
