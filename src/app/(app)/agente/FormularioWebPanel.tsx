import { PATRON_DE_SLUG, slugAlAzar } from "@/core/web/formulario";
import type { TranslationKey } from "@/lib/i18n";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import type { FormularioDelInquilino } from "@/server/web/formulario-del-inquilino";

import { FormularioApi } from "@/components/FormularioApi";
import { BOTON, CAMPO, ETIQUETA } from "@/components/estilos-de-formulario";
import { patronHtml } from "@/components/patron-html";

type Traducir = (clave: TranslationKey) => string;

export function FormularioWebPanel({
  t,
  formulario,
  pendiente,
}: {
  t: Traducir;
  formulario: FormularioDelInquilino | null;
  pendiente: boolean;
}) {
  // Los topes salen de la misma tabla que los aplica: el texto no se desfasa si alguien los cambia.
  const ayuda = t("formulario.ayuda")
    .replace("{porHora}", String(RATE_LIMIT_CONFIGS.DENUNCIA_WEB_SLUG.limit))
    .replace("{porDia}", String(RATE_LIMIT_CONFIGS.DENUNCIA_WEB_SLUG_DIA.limit));

  if (pendiente) return <p className="text-sm text-amber-700">{t("migracion.pendiente")}</p>;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t("formulario.titulo")}</h2>
        <p className="mt-1 text-sm text-slate-500">{ayuda}</p>
      </div>

      {formulario ? (
        <div className="space-y-3">
          <p className="text-sm">
            <span className="text-xs font-medium text-slate-500">{t("formulario.enlace")}: </span>
            <a href={`/denuncia/${formulario.slug}`} className="font-mono text-violet-700 underline">
              {`/denuncia/${formulario.slug}`}
            </a>
          </p>
          <p className="text-sm text-slate-500">
            {t(formulario.activo ? "formulario.encendido" : "formulario.apagado")}
          </p>
          <FormularioApi
            action="/api/admin/formulario-web"
            method="PUT"
            okTexto={t("formulario.guardado")}
            errorTexto={t("formulario.error")}
          >
            <button
              type="submit"
              name="activo"
              value={formulario.activo ? "false" : "true"}
              className={BOTON}
            >
              {t(formulario.activo ? "formulario.apagar" : "formulario.encender")}
            </button>
          </FormularioApi>
        </div>
      ) : (
        <FormularioApi
          action="/api/admin/formulario-web"
          method="PUT"
          okTexto={t("formulario.guardado")}
          errorTexto={t("formulario.error")}
          className="space-y-3"
        >
          <label className={ETIQUETA}>
            {t("formulario.slug")}
            <input
              name="slug"
              required
              minLength={4}
              maxLength={40}
              pattern={patronHtml(PATRON_DE_SLUG)}
              defaultValue={slugAlAzar()}
              className={`${CAMPO} block w-full font-mono`}
            />
            <span className="block font-normal">{t("formulario.slugAyuda")}</span>
          </label>
          <button type="submit" name="activo" value="true" className={BOTON}>
            {t("formulario.crear")}
          </button>
        </FormularioApi>
      )}
    </div>
  );
}
