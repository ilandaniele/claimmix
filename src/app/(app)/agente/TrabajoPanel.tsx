"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n/LocaleContext";
import type { TranslationKey } from "@/lib/i18n";
import type { CampoDeTrabajo, TrabajoDelEquipo } from "@/server/cases/trabajo-del-equipo";

/*
 * Cómo trabaja el equipo (B9, B10, B11, B13), editable por un admin.
 *
 * Este panel no importa zod ni los módulos del núcleo: los valores por defecto
 * le llegan del servidor, que también valida cada guardado. Cada sección edita
 * el JSON de su configuración; lo que el servidor rechaza vuelve con el motivo.
 */

const bonito = (valor: unknown) => JSON.stringify(valor, null, 2);

/** Los uuid de personas que nombran las reglas guardadas, sin repetir. Lee lo guardado sin confiar en su forma. */
function personasDe(reglas: unknown): string[] {
  const lista = (reglas as { reglas?: unknown } | null)?.reglas;
  if (!Array.isArray(lista)) return [];
  const ids = lista.flatMap((r: { personas?: unknown } | null) =>
    Array.isArray(r?.personas) ? r.personas.filter((p): p is string => typeof p === "string") : []
  );
  return [...new Set(ids)];
}

interface SeccionProps {
  campo: CampoDeTrabajo;
  titulo: TranslationKey;
  ayuda: TranslationKey;
  leyenda?: TranslationKey;
  guardado: unknown;
  porDefecto: unknown;
  alGuardar: (valor: unknown) => void;
  children?: React.ReactNode;
}

function Seccion({ campo, titulo, ayuda, leyenda, guardado, porDefecto, alGuardar, children }: SeccionProps) {
  const t = useT();
  // Sin configuración propia se parte de lo que rige, para editarlo y no escribir de cero.
  const [texto, setTexto] = useState(() => bonito(guardado ?? porDefecto));
  const [estado, setEstado] = useState<"idle" | "guardando" | "ok" | "error">("idle");
  const [motivo, setMotivo] = useState<string | null>(null);

  async function enviar(valor: unknown) {
    setEstado("guardando");
    setMotivo(null);
    try {
      const res = await fetch("/api/admin/trabajo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campo, valor }),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => null);
        setMotivo(cuerpo?.error?.message ?? null);
        setEstado("error");
        return;
      }
      alGuardar(valor);
      if (valor === null) setTexto(bonito(porDefecto));
      setEstado("ok");
    } catch {
      setEstado("error");
    }
  }

  function guardar() {
    let valor: unknown;
    try {
      valor = JSON.parse(texto);
    } catch {
      setMotivo(t("trabajo.jsonInvalido"));
      setEstado("error");
      return;
    }
    void enviar(valor);
  }

  const idTitulo = `trabajo-${campo}`;
  return (
    <section aria-labelledby={idTitulo} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={idTitulo} className="text-sm font-semibold text-slate-800">
          {t(titulo)}
        </h3>
        <span className="text-xs text-slate-500">{t(guardado === null ? "trabajo.porDefecto" : "trabajo.propio")}</span>
      </div>
      <p className="text-xs text-slate-500">{t(ayuda)}</p>
      {children}
      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        aria-label={t(titulo)}
        rows={12}
        spellCheck={false}
        className="w-full rounded border border-slate-300 bg-white p-2 font-mono text-xs text-slate-800 focus:border-blue-500 focus:outline-none"
      />
      {leyenda && <p className="text-xs font-medium text-slate-600">{t(leyenda)}</p>}
      <div className="flex gap-2">
        <button
          onClick={guardar}
          disabled={estado === "guardando"}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {t(estado === "guardando" ? "claveIa.guardando" : "claveIa.guardar")}
        </button>
        <button
          onClick={() => void enviar(null)}
          disabled={estado === "guardando" || guardado === null}
          className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {t("trabajo.restablecer")}
        </button>
      </div>
      {(estado === "ok" || estado === "error") && (
        <p role="status" className={estado === "ok" ? "text-xs text-emerald-600" : "text-xs text-red-500"}>
          {estado === "ok" ? t("trabajo.guardado") : (motivo ?? t("trabajo.errorAlGuardar"))}
        </p>
      )}
    </section>
  );
}

export function TrabajoPanel() {
  const t = useT();
  const [datos, setDatos] = useState<TrabajoDelEquipo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/trabajo", { cache: "no-store" })
      .then(async (res) => {
        if (res.ok) return (await res.json()) as TrabajoDelEquipo;
        const cuerpo = await res.json().catch(() => null);
        throw new Error(cuerpo?.error?.message ?? "");
      })
      .then((d) => {
        if (!cancelled) setDatos(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || t("trabajo.error"));
      });
    return () => {
      cancelled = true;
    };
    // `t` cambia con el idioma; volver a pedir la configuración por eso sería peor que el problema.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <p role="alert" className="text-sm text-red-500">{error}</p>;
  if (!datos) return <p className="text-sm text-slate-500">{t("trabajo.cargando")}</p>;

  const guardar = (campo: CampoDeTrabajo) => (valor: unknown) =>
    setDatos((d) => (d ? { ...d, guardado: { ...d.guardado, [campo]: valor } } : d));
  const porId = new Map(datos.carga.map((p) => [p.id, p]));
  const enReglas = personasDe(datos.guardado.reglas_asignacion);

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">{t("trabajo.intro")}</p>

      <Seccion
        campo="reglas_asignacion"
        titulo="trabajo.asignacion.titulo"
        ayuda="trabajo.asignacion.ayuda"
        guardado={datos.guardado.reglas_asignacion}
        porDefecto={datos.porDefecto.reglas_asignacion}
        alGuardar={guardar("reglas_asignacion")}
      >
        <div>
          <h4 className="text-xs font-medium text-slate-700">{t("trabajo.carga.titulo")}</h4>
          {datos.carga.length === 0 ? (
            <p className="text-xs text-slate-500">{t("trabajo.carga.vacia")}</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
              {datos.carga.map((p) => (
                <li key={p.id}>
                  {p.full_name} · {t("trabajo.carga.abiertos").replace("{n}", String(p.abiertos))}
                </li>
              ))}
            </ul>
          )}
        </div>
        {enReglas.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-slate-700">{t("trabajo.reglas.personas")}</h4>
            <ul className="mt-1 space-y-0.5 text-xs">
              {enReglas.map((id) => {
                const persona = porId.get(id);
                return persona ? (
                  <li key={id} className="text-slate-700">
                    {persona.full_name}
                  </li>
                ) : (
                  <li key={id} className="text-red-500">
                    <span className="font-mono">{id}</span> · {t("trabajo.usuarioInexistente")}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Seccion>

      <Seccion
        campo="plazos"
        titulo="trabajo.plazos.titulo"
        ayuda="trabajo.plazos.ayuda"
        guardado={datos.guardado.plazos}
        porDefecto={datos.porDefecto.plazos}
        alGuardar={guardar("plazos")}
      >
        <div>
          <h4 className="text-xs font-medium text-slate-700">{t("trabajo.plazos.legales")}</h4>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
            <li>
              {t("plazo.art46")}: {t("trabajo.plazos.art46").replace("{dias}", String(datos.legales.art46.dias))}
            </li>
            <li>
              {t("plazo.art56")}: {t("trabajo.plazos.art56").replace("{dias}", String(datos.legales.art56.dias))}
            </li>
          </ul>
          <h4 className="mt-2 text-xs font-medium text-slate-700">{t("trabajo.plazos.propios")}</h4>
        </div>
      </Seccion>

      <Seccion
        campo="plan_por_tipo"
        titulo="trabajo.plan.titulo"
        ayuda="trabajo.plan.ayuda"
        guardado={datos.guardado.plan_por_tipo}
        porDefecto={datos.porDefecto.plan_por_tipo}
        alGuardar={guardar("plan_por_tipo")}
      />

      <Seccion
        campo="pesos_puntaje"
        titulo="trabajo.pesos.titulo"
        ayuda="trabajo.pesos.ayuda"
        leyenda="trabajo.pesos.leyenda"
        guardado={datos.guardado.pesos_puntaje}
        porDefecto={datos.porDefecto.pesos_puntaje}
        alGuardar={guardar("pesos_puntaje")}
      />
    </div>
  );
}
