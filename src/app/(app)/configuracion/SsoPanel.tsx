import type { TranslationKey } from "@/lib/i18n";
import type { PanelSso } from "@/server/sso/panel";

import { cambiarSso, guardarSso, probarSso, verificarSso } from "./sso-actions";
import { esExito, type ResultadoSso } from "./sso-resultados";

type Traducir = (clave: TranslationKey) => string;

interface Props {
  panel: PanelSso;
  t: Traducir;
  /** El correo del admin, para dejar lista la prueba. */
  email: string;
  /** Lo que pasó con la última acción, tomado de la dirección. */
  resultado: ResultadoSso | null;
}

const campo =
  "w-full rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none";
const principal =
  "rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50";
const secundario =
  "rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";

function Etiqueta({ para, children }: { para: string; children: React.ReactNode }) {
  return (
    <label htmlFor={para} className="text-xs font-medium text-slate-700">
      {children}
    </label>
  );
}

function Bloque({ titulo, children }: { titulo?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 border-t border-slate-100 pt-4">
      {titulo && <p className="text-xs font-semibold text-slate-700">{titulo}</p>}
      {children}
    </div>
  );
}

/**
 * El SSO de la aseguradora (B19), armado en el servidor: formularios que llaman
 * a las acciones de `sso-actions.ts`, sin JavaScript de cliente. Los pasos van en
 * el orden en que se hacen: guardar el IdP, verificar el dominio, activar,
 * probar, exigir. Cada uno aparece cuando el anterior está hecho.
 */
export function SsoPanel({ panel, t, email, resultado }: Props) {
  const aviso = resultado && (
    <p
      role="status"
      className={`rounded border px-3 py-2 text-xs ${
        esExito(resultado) ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800"
      }`}
    >
      {t(`configuracion.sso.r.${resultado}`)}
    </p>
  );

  if (panel.migracion_pendiente) {
    return <p className="text-xs text-slate-500">{t("migracion.pendiente")}</p>;
  }

  const listo = Boolean(panel.issuer && panel.client_id && panel.tiene_secreto && panel.dominio_verificado_en);
  const estado = panel.exigir ? "exigido" : panel.activo ? "activo" : "apagado";

  return (
    <div className="space-y-4">
      {aviso}
      <p className="text-xs text-slate-500">{t("configuracion.sso.ayuda")}</p>
      <p className="text-xs text-slate-600">
        <span className="font-medium">{t("configuracion.sso.estado")}:</span>{" "}
        {t(`configuracion.sso.estado.${estado}`)}
      </p>

      <form action={guardarSso} className="space-y-3">
        <div className="space-y-1">
          <p className="text-xs font-medium text-slate-700">{t("configuracion.sso.urlDeVuelta")}</p>
          <code className="block break-all rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
            {panel.url_de_vuelta}
          </code>
        </div>

        <div className="space-y-1">
          <Etiqueta para="sso-issuer">{t("configuracion.sso.issuer")}</Etiqueta>
          <input
            id="sso-issuer"
            name="issuer"
            type="url"
            required
            defaultValue={panel.issuer ?? ""}
            placeholder="https://"
            aria-describedby="sso-issuer-ayuda"
            className={campo}
          />
          <p id="sso-issuer-ayuda" className="text-xs text-slate-500">
            {t("configuracion.sso.issuerAyuda")}
          </p>
        </div>

        <div className="space-y-1">
          <Etiqueta para="sso-client-id">{t("configuracion.sso.clientId")}</Etiqueta>
          <input
            id="sso-client-id"
            name="client_id"
            type="text"
            required
            autoComplete="off"
            defaultValue={panel.client_id ?? ""}
            className={campo}
          />
        </div>

        <div className="space-y-1">
          <Etiqueta para="sso-client-secret">{t("configuracion.sso.clientSecret")}</Etiqueta>
          {/* Nunca se rellena: el secreto se guarda cifrado y no vuelve. */}
          <input
            id="sso-client-secret"
            name="client_secret"
            type="password"
            autoComplete="new-password"
            required={!panel.tiene_secreto}
            aria-describedby="sso-secret-ayuda"
            className={campo}
          />
          <p id="sso-secret-ayuda" className="text-xs text-slate-500">
            {t(panel.tiene_secreto ? "configuracion.sso.secretoGuardado" : "configuracion.sso.secretoFalta")}
          </p>
        </div>

        <div className="space-y-1">
          <Etiqueta para="sso-dominio">{t("configuracion.sso.dominio")}</Etiqueta>
          <input
            id="sso-dominio"
            name="dominio"
            type="text"
            required
            autoComplete="off"
            defaultValue={panel.dominio ?? ""}
            placeholder="empresa.com"
            aria-describedby="sso-dominio-ayuda"
            className={campo}
          />
          <p id="sso-dominio-ayuda" className="text-xs text-slate-500">
            {t("configuracion.sso.dominioAyuda")}
          </p>
        </div>

        <button type="submit" className={principal}>
          {t("claveIa.guardar")}
        </button>
      </form>

      {panel.dominio && (
        <Bloque titulo={t("configuracion.sso.verificacion")}>
          {panel.dominio_verificado_en ? (
            <p className="text-xs text-green-700">
              {t("configuracion.sso.verificado")}: {panel.dominio}
            </p>
          ) : (
            <>
              <p className="text-xs text-slate-500">{t("configuracion.sso.verificacionAyuda")}</p>
              {panel.registro && (
                <dl className="space-y-1 text-xs text-slate-700">
                  <dt className="font-medium">{t("configuracion.sso.registroNombre")}</dt>
                  <dd>
                    <code className="block break-all rounded bg-slate-50 px-2 py-1.5">{panel.registro.nombre}</code>
                  </dd>
                  <dt className="font-medium">{t("configuracion.sso.registroValor")}</dt>
                  <dd>
                    <code className="block break-all rounded bg-slate-50 px-2 py-1.5">{panel.registro.valor}</code>
                  </dd>
                </dl>
              )}
              <form action={verificarSso}>
                <button type="submit" className={secundario}>
                  {t("configuracion.sso.verificar")}
                </button>
              </form>
            </>
          )}
        </Bloque>
      )}

      <Bloque>
        {!panel.activo && <p className="text-xs text-slate-500">{t("configuracion.sso.activarAyuda")}</p>}
        <form action={cambiarSso}>
          <input type="hidden" name="campo" value="activo" />
          <input type="hidden" name="valor" value={panel.activo ? "0" : "1"} />
          <button type="submit" disabled={!panel.activo && !listo} className={panel.activo ? secundario : principal}>
            {t(panel.activo ? "configuracion.sso.apagar" : "configuracion.sso.activar")}
          </button>
        </form>
      </Bloque>

      {panel.activo && (
        <>
          <Bloque titulo={t("configuracion.sso.probarTitulo")}>
            <p className="text-xs text-slate-500">{t("configuracion.sso.probarAyuda")}</p>
            <form action={probarSso} className="flex gap-2">
              <input
                name="email"
                type="email"
                required
                defaultValue={email}
                aria-label={t("field.email")}
                className={campo}
              />
              <button type="submit" className={secundario}>
                {t("configuracion.sso.probar")}
              </button>
            </form>
          </Bloque>

          <Bloque titulo={t("configuracion.sso.exigirTitulo")}>
            <p className="text-xs text-slate-500">{t("configuracion.sso.exigirAyuda")}</p>
            <form action={cambiarSso}>
              <input type="hidden" name="campo" value="exigir" />
              <input type="hidden" name="valor" value={panel.exigir ? "0" : "1"} />
              <button type="submit" className={secundario}>
                {t(panel.exigir ? "configuracion.sso.dejarDeExigir" : "configuracion.sso.exigir")}
              </button>
            </form>
          </Bloque>
        </>
      )}
    </div>
  );
}
