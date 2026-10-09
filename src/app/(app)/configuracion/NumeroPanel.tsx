import type { TranslationKey } from "@/lib/i18n";
import { esExitoDelNumero, type ResultadoDelNumero } from "@/server/alta/numero-resultados";

import { BotonDeEnvio } from "./BotonDeEnvio";
import { pedirCodigoDelNumero, verificarCodigoDelNumero } from "./numero-actions";

type Traducir = (clave: TranslationKey) => string;

interface Props {
  t: Traducir;
  /** Lo que pasó con la última acción, tomado de la dirección. */
  resultado: ResultadoDelNumero | null;
  /** Si todavía hay un número por conectar: sin esto sólo se pinta el resultado. */
  formularios: boolean;
}

const campo =
  "w-32 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none";
const principal =
  "rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50";
const secundario =
  "rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";

/**
 * Conectar el WhatsApp con un código, en /configuracion y en /preparando (alta
 * automática): pedir el código por SMS o llamada y escribirlo. Es de servidor,
 * igual que `SsoPanel`: dos formularios que llaman a las acciones de
 * `numero-actions.ts`. El único JavaScript de cliente son los botones
 * (`BotonDeEnvio`), que se apagan mientras el pedido va.
 *
 * La página decide cuándo mostrarlo (bandera prendida, número pedido, prueba
 * vigente). Acá no se muestra el número ni nada que salga de Meta: el aviso es
 * una clave de la lista cerrada de `numero-resultados.ts`.
 */
export function NumeroPanel({ t, resultado, formularios }: Props) {
  return (
    <div className="mt-4 space-y-4 border-t border-slate-100 pt-4">
      {resultado && (
        <p
          role="status"
          className={`rounded border px-3 py-2 text-xs ${
            esExitoDelNumero(resultado)
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {t(`configuracion.numero.r.${resultado}`)}
        </p>
      )}
      {formularios && (
        <>
          <h3 className="text-xs font-semibold text-slate-700">{t("configuracion.numero.titulo")}</h3>
          <p className="text-xs text-slate-500">{t("configuracion.numero.antes")}</p>
          <p className="text-xs text-slate-500">{t("configuracion.numero.nombre")}</p>

          <form action={pedirCodigoDelNumero} className="space-y-2">
            <p className="text-xs text-slate-700">{t("configuracion.numero.paso1")}</p>
            <div className="flex gap-2">
              <BotonDeEnvio name="metodo" value="SMS" className={principal}>
                {t("configuracion.numero.porSms")}
              </BotonDeEnvio>
              <BotonDeEnvio name="metodo" value="VOICE" className={secundario}>
                {t("configuracion.numero.porLlamada")}
              </BotonDeEnvio>
            </div>
          </form>

          <form action={verificarCodigoDelNumero} className="space-y-2">
            <label htmlFor="wa-codigo" className="block text-xs text-slate-700">
              {t("configuracion.numero.paso2")}
            </label>
            <div className="flex gap-2">
              <input
                id="wa-codigo"
                name="codigo"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                required
                aria-label={t("configuracion.numero.codigo")}
                className={campo}
              />
              <BotonDeEnvio className={principal}>{t("configuracion.numero.conectar")}</BotonDeEnvio>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
