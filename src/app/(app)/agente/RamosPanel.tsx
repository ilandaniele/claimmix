import { CATALOGO_DE_DOCUMENTOS } from "@/core/case/required-docs";
import { CATALOGO_DE_DATOS } from "@/core/case/required-fields";
import {
  FORMATO_DE_CLAVE_DE_RAMO,
  TOPE_DE_RAMOS_PROPIOS,
  esRamoNativo,
  type RamoDelInquilino,
} from "@/core/case/ramos";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { nombreDeTipo } from "@/lib/i18n/tipos-de-siniestro";
import { etiquetaDeCampo } from "@/lib/labels/etiqueta-de-campo";

import { FormularioApi } from "@/components/FormularioApi";
import { BOTON, CAMPO, ETIQUETA } from "@/components/estilos-de-formulario";
import { patronHtml } from "@/components/patron-html";

type Traducir = (clave: TranslationKey) => string;

function Marcas({
  t,
  nombre,
  titulo,
  opciones,
  elegidas,
}: {
  t: Traducir;
  nombre: string;
  titulo: string;
  opciones: readonly string[];
  elegidas: readonly string[];
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium text-slate-500">{titulo}</legend>
      <div className="grid gap-1 sm:grid-cols-2">
        {opciones.map((o) => (
          <label key={o} className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" name={`${nombre}[]`} value={o} defaultChecked={elegidas.includes(o)} />
            {etiquetaDeCampo(o, t)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function FormularioDeRamo({
  t,
  ramo,
}: {
  t: Traducir;
  ramo?: RamoDelInquilino;
}) {
  return (
    <FormularioApi
      action="/api/admin/ramos"
      method="PUT"
      okTexto={t("ramos.guardado")}
      errorTexto={t("ramos.error")}
      className="space-y-3"
    >
      <label className={ETIQUETA}>
        {t("ramos.clave")}
        <input
          name="clave"
          required
          minLength={2}
          maxLength={40}
          pattern={patronHtml(FORMATO_DE_CLAVE_DE_RAMO)}
          defaultValue={ramo?.clave}
          readOnly={Boolean(ramo)}
          className={`${CAMPO} block w-full font-mono`}
        />
        {!ramo && <span className="block font-normal">{t("ramos.claveAyuda")}</span>}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={ETIQUETA}>
          {t("ramos.nombreEs")}
          <input name="nombre_es" required maxLength={60} defaultValue={ramo?.nombre_es} className={`${CAMPO} block w-full`} />
        </label>
        <label className={ETIQUETA}>
          {t("ramos.nombreEn")}
          <input name="nombre_en" required maxLength={60} defaultValue={ramo?.nombre_en} className={`${CAMPO} block w-full`} />
        </label>
      </div>
      <Marcas t={t} nombre="documentos" titulo={t("ramos.documentos")} opciones={CATALOGO_DE_DOCUMENTOS} elegidas={ramo?.documentos ?? []} />
      {/* Un ramo del código conserva sus datos: la fila sólo le cambia los documentos. */}
      {!(ramo && esRamoNativo(ramo.clave)) && (
        <Marcas t={t} nombre="datos" titulo={t("ramos.datos")} opciones={CATALOGO_DE_DATOS} elegidas={ramo?.datos ?? []} />
      )}
      <button type="submit" className={BOTON}>
        {t("ramos.guardar")}
      </button>
    </FormularioApi>
  );
}

export function RamosPanel({
  t,
  idioma,
  ramos,
  pendiente,
}: {
  t: Traducir;
  idioma: Locale;
  ramos: RamoDelInquilino[];
  pendiente: boolean;
}) {
  if (pendiente) return <p className="text-sm text-amber-700">{t("migracion.pendiente")}</p>;
  const lleno = ramos.length >= TOPE_DE_RAMOS_PROPIOS;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t("ramos.titulo")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("ramos.ayuda")}</p>
      </div>

      {ramos.length === 0 && <p className="text-sm text-slate-500">{t("ramos.vacio")}</p>}
      {ramos.map((r) => (
        <details key={r.clave} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <summary className="cursor-pointer text-sm font-medium">
            {nombreDeTipo(r.clave, t, ramos, idioma)} <span className="font-mono text-xs text-slate-500">{r.clave}</span>
          </summary>
          <div className="mt-3 space-y-3">
            <FormularioDeRamo t={t} ramo={r} />
            <FormularioApi
              action={`/api/admin/ramos?clave=${encodeURIComponent(r.clave)}`}
              method="DELETE"
              okTexto={t("ramos.guardado")}
              errorTexto={t("ramos.error")}
              confirmar={t("ramos.confirmarBorrar")}
            >
              <button type="submit" className="rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-700">
                {t("ramos.borrar")}
              </button>
            </FormularioApi>
          </div>
        </details>
      ))}

      {lleno ? (
        <p className="text-sm text-slate-500">{t("ramos.tope").replace("{n}", String(TOPE_DE_RAMOS_PROPIOS))}</p>
      ) : (
        <details className="rounded-lg border border-dashed border-slate-300 p-3 dark:border-slate-700">
          <summary className="cursor-pointer text-sm font-medium">{t("ramos.nuevo")}</summary>
          <div className="mt-3">
            <FormularioDeRamo t={t} />
          </div>
        </details>
      )}
    </div>
  );
}
