"use client";

import { useState } from "react";

import type { ClaveDelCliente } from "@/lib/i18n";
import { useT } from "@/lib/i18n/LocaleContext";
import { textoDelMotivo } from "@/lib/i18n/motivo-de-core";
import type { VistaDeLaConfig } from "@/server/core-sync/config";

interface Props {
  inicial: VistaDeLaConfig | null;
  migracionPendiente: boolean;
}

type Respuesta = Record<string, unknown> & {
  webhook_url?: string | null;
  enabled?: boolean;
  secreto?: string;
  clave?: string;
  prefijo?: string;
  ok?: boolean;
  motivo?: string | null;
};

// El `message` del servidor viene en castellano: se traduce el `motivo`, o el código.
const RECHAZOS = new Map<string, ClaveDelCliente>([
  ["url", "configuracion.core.urlAyuda"],
  ["migracion", "configuracion.core.migracionPendiente"],
  ["incompleto", "configuracion.core.incompleto"],
  ["secreto_ilegible", "configuracion.core.secretoIlegible"],
  ["RATE_LIMITED", "error.rateLimited"],
]);

const boton =
  "rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";

/**
 * La entrega al sistema de la aseguradora (B5): URL, secreto de firma, clave
 * de lectura y la prueba. El servidor valida todo; el secreto y la clave en
 * claro sólo existen en la respuesta que los crea y en este estado.
 */
export function CoreSyncPanel({ inicial, migracionPendiente }: Props) {
  const t = useT();
  const [url, setUrl] = useState(inicial?.webhook_url ?? "");
  const [enabled, setEnabled] = useState(inicial?.enabled ?? false);
  const [tieneSecreto, setTieneSecreto] = useState(inicial?.tiene_secreto ?? false);
  const [prefijo, setPrefijo] = useState(inicial?.api_key_prefix ?? null);
  // Separados: rotar o revocar la clave no puede borrar un secreto que todavía no se copió.
  const [secretoNuevo, setSecretoNuevo] = useState<string | null>(null);
  const [claveNueva, setClaveNueva] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);

  if (migracionPendiente) {
    return <p className="text-xs text-slate-500">{t("configuracion.core.migracionPendiente")}</p>;
  }

  async function pedir(method: "PATCH" | "POST", body: object): Promise<Respuesta | null> {
    setOcupado(true);
    setAviso(null);
    try {
      const res = await fetch("/api/admin/core-sync", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const datos = await res.json().catch(() => null);
      if (res.ok) return datos as Respuesta;
      const rechazo = RECHAZOS.get(datos?.error?.details?.motivo ?? datos?.error?.code ?? "");
      setAviso({ ok: false, texto: rechazo ? `${t("configuracion.core.error")} ${t(rechazo)}` : t("configuracion.core.error") });
    } catch {
      setAviso({ ok: false, texto: t("configuracion.core.error") });
    } finally {
      setOcupado(false);
    }
    return null;
  }

  async function guardar(cambios: { webhook_url?: string | null; enabled?: boolean }) {
    const d = await pedir("PATCH", cambios);
    if (!d) return;
    setUrl(d.webhook_url ?? "");
    setEnabled(Boolean(d.enabled));
    setAviso({ ok: true, texto: t("configuracion.core.guardado") });
  }

  async function accion(nombre: string, reemplaza: boolean) {
    if (reemplaza && !window.confirm(t("configuracion.core.confirmar"))) return;
    const d = await pedir("POST", { accion: nombre });
    if (!d) return;
    if (d.secreto) {
      setTieneSecreto(true);
      setSecretoNuevo(d.secreto);
    } else if (d.clave) {
      setPrefijo(d.prefijo ?? null);
      setClaveNueva(d.clave);
    } else if (nombre === "revocar-clave") {
      setPrefijo(null);
      setClaveNueva(null);
    } else if (nombre === "probar-envio") {
      setAviso(
        d.ok
          ? { ok: true, texto: t("configuracion.core.pruebaOk") }
          : { ok: false, texto: `${t("configuracion.core.pruebaFallo")} ${textoDelMotivo(t, d.motivo)}` }
      );
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">{t("configuracion.core.ayuda")}</p>

      <div className="space-y-1">
        <label htmlFor="core-url" className="text-xs font-medium text-slate-700">
          {t("configuracion.core.url")}
        </label>
        <div className="flex gap-2">
          <input
            id="core-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            aria-describedby="core-url-ayuda"
            className="flex-1 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={() => guardar({ webhook_url: url.trim() || null })}
            disabled={ocupado}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {t("claveIa.guardar")}
          </button>
        </div>
        <p id="core-url-ayuda" className="text-xs text-slate-500">
          {t("configuracion.core.urlAyuda")}
        </p>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium text-slate-700">{t("configuracion.core.secreto")}</p>
        <p className="text-xs text-slate-500">
          {t(tieneSecreto ? "configuracion.core.conSecreto" : "configuracion.core.sinSecreto")}
        </p>
        <button onClick={() => accion("generar-secreto", tieneSecreto)} disabled={ocupado} className={boton}>
          {t(tieneSecreto ? "configuracion.core.rotarSecreto" : "configuracion.core.generarSecreto")}
        </button>
        {secretoNuevo && <Revelado key={secretoNuevo} titulo={t("configuracion.core.secretoNuevo")} valor={secretoNuevo} />}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={enabled}
            disabled={ocupado}
            onChange={(e) => guardar({ enabled: e.target.checked })}
          />
          {t("configuracion.core.activar")}
        </label>
        <button onClick={() => accion("probar-envio", false)} disabled={ocupado} className={boton}>
          {t("configuracion.core.probar")}
        </button>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium text-slate-700">{t("configuracion.core.clave")}</p>
        <p className="text-xs text-slate-500">
          {prefijo ? (
            <>
              {t("configuracion.core.conClave")} <span className="font-mono">cmk_…_{prefijo}…</span>
            </>
          ) : (
            t("configuracion.core.sinClave")
          )}
        </p>
        <div className="flex gap-2">
          <button onClick={() => accion("rotar-clave", Boolean(prefijo))} disabled={ocupado} className={boton}>
            {t(prefijo ? "configuracion.core.rotarClave" : "configuracion.core.crearClave")}
          </button>
          {prefijo && (
            <button onClick={() => accion("revocar-clave", true)} disabled={ocupado} className={boton}>
              {t("configuracion.core.revocarClave")}
            </button>
          )}
        </div>
        {claveNueva && <Revelado key={claveNueva} titulo={t("configuracion.core.claveNueva")} valor={claveNueva} />}
      </div>

      {aviso && (
        <p role="status" className={aviso.ok ? "text-xs text-emerald-600" : "text-xs text-red-500"}>
          {aviso.texto}
        </p>
      )}
    </div>
  );
}

/** Un secreto o una clave recién creados, en su sección y con su nombre. */
function Revelado({ titulo, valor }: { titulo: string; valor: string }) {
  const t = useT();
  const [copiado, setCopiado] = useState(false);
  return (
    <div role="alert" aria-label={titulo} className="space-y-2 rounded border border-amber-200 bg-amber-50 px-3 py-2">
      <p className="text-xs font-medium text-amber-800">
        {titulo} {t("configuracion.core.soloUnaVez")}
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all font-mono text-xs text-slate-800">{valor}</code>
        <button
          onClick={() => navigator.clipboard.writeText(valor).then(() => setCopiado(true), () => {})}
          className={boton}
        >
          {t(copiado ? "configuracion.core.copiado" : "configuracion.core.copiar")}
        </button>
      </div>
    </div>
  );
}
