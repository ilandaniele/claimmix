import { VERSION_DEL_ENTRENAMIENTO_BASE, seccionesDelPaso } from "@/core/agente/entrenamiento-base";
import { PASOS_POR_TIPO, type TipoDeRegla } from "@/core/agente/indicaciones";
import { PASOS_DEL_AGENTE } from "@/core/agente/propuesta";
import { BOTON } from "@/components/estilos-de-formulario";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { aprendidoEnConversacion } from "@/server/training/aprendido-en-conversacion";

type Traducir = (clave: TranslationKey) => string;

const TIPOS = Object.keys(PASOS_POR_TIPO) as TipoDeRegla[];

/**
 * La base del agente, sólo lectura: el texto sale del módulo generado, sin consultas.
 * Es de servidor a propósito: ~30 KB de texto que no tienen que pasar por el JS del cliente.
 */
export function EntrenamientoBasePanel({ t, idioma }: { t: Traducir; idioma: Locale }) {
  const prendida = aprendidoEnConversacion();

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t("base.titulo")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("base.explicacion")}</p>
        <p className="mt-1 font-mono text-xs text-slate-500">
          {t("base.version").replace("{version}", VERSION_DEL_ENTRENAMIENTO_BASE)}
        </p>
      </div>

      {PASOS_DEL_AGENTE.map((paso) => (
        <section key={paso} className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t(`base.paso.${paso}` as TranslationKey)}
          </h3>
          {seccionesDelPaso(paso).map((s) => (
            <details key={s.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <summary className="cursor-pointer text-sm font-medium">
                {s.titulo[idioma]}{" "}
                <span className="font-mono text-xs text-slate-500">
                  {s.id} · {t(`base.modo.${s.modo}` as TranslationKey)} · {s.ruta}
                </span>
              </summary>
              {/* El texto es la política tal como corre, en castellano en los dos idiomas. */}
              <pre lang="es" className="mt-3 whitespace-pre-wrap text-xs text-slate-700 dark:text-slate-300">
                {s.texto}
              </pre>
            </details>
          ))}
        </section>
      ))}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("base.reglas.titulo")}</h3>
        <p className="text-sm text-slate-500">
          {t(prendida ? "base.reglas.bandera_prendida" : "base.reglas.bandera_apagada")}
        </p>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="py-1 pr-3 font-medium">{t("base.reglas.tipo")}</th>
              <th className="py-1 font-medium">{t("base.reglas.pasos")}</th>
            </tr>
          </thead>
          <tbody>
            {TIPOS.map((tipo) => (
              <tr key={tipo} className="border-t border-slate-200 dark:border-slate-800">
                <td className="py-1.5 pr-3">{t(`reglas.tipo.${tipo}` as TranslationKey)}</td>
                <td className="py-1.5">
                  {PASOS_POR_TIPO[tipo].map((paso, i) => {
                    // Sin la bandera, decidir y redactar no leen reglas: la extracción sí.
                    const activo = prendida || paso === "extraccion";
                    return (
                      <span key={paso} data-activo={activo} className={activo ? undefined : "text-slate-400 line-through"}>
                        {i > 0 && ", "}
                        {t(`base.paso.${paso}` as TranslationKey)}
                      </span>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="space-y-1">
        <a href="/api/admin/prompt-rules?formato=propuesta" download className={`${BOTON} inline-block`}>
          {t("base.propuesta.boton")}
        </a>
        <p className="text-xs text-slate-500">{t("base.propuesta.aviso")}</p>
      </div>
    </div>
  );
}
