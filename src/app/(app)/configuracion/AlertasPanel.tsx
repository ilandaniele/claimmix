"use client";

import { useState } from "react";

import { useT } from "@/lib/i18n/LocaleContext";

interface Props {
  inicial: string[];
  /** Los recordatorios (B4). undefined: no se pudieron leer y no se muestran. */
  horasIniciales?: number[];
}

// Las tres que ofrece el panel; el servidor valida cualquier otra.
const OPCIONES = {
  apagado: [],
  h48: [48],
  h48y120: [48, 120],
} as const satisfies Record<string, readonly number[]>;
type Opcion = keyof typeof OPCIONES;

function opcionDe(horas: readonly number[]): Opcion | undefined {
  return (Object.keys(OPCIONES) as Opcion[]).find((o) => OPCIONES[o].join() === horas.join());
}

/**
 * La lista de avisos de casos urgentes de este tenant, editable por un admin,
 * y cuándo se le recuerda al asegurado lo que falta (B4).
 *
 * El servidor es el único que valida (dirección vedada, tope de 10, formato):
 * este panel no importa `@/lib/email/reserved` ni ningún módulo de servidor,
 * para no cargar peso al cliente que no le sirve para nada acá.
 */
export function AlertasPanel({ inicial, horasIniciales }: Props) {
  const [texto, setTexto] = useState(inicial.join("\n"));
  // Horas fuera de las tres (p. ej. {72}) se ofrecen tal cual: mostrarlas como
  // «apagado» las apagaba al guardar sólo la lista.
  const [opcion, setOpcion] = useState<Opcion | "actual">(
    horasIniciales ? (opcionDe(horasIniciales) ?? "actual") : "apagado"
  );
  const [estado, setEstado] = useState<"idle" | "guardando" | "ok" | "error">("idle");
  const [motivo, setMotivo] = useState<string | null>(null);
  const t = useT();

  async function guardar() {
    setEstado("guardando");
    setMotivo(null);
    try {
      const res = await fetch("/api/admin/alertas", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emails: texto.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
          ...(horasIniciales
            ? { recordatorio_horas: opcion === "actual" ? horasIniciales : OPCIONES[opcion] }
            : {}),
        }),
      });
      if (res.ok) {
        const { emails } = await res.json();
        setTexto(emails.join("\n"));
        setEstado("ok");
      } else {
        const cuerpo = await res.json().catch(() => null);
        setMotivo(cuerpo?.error?.message ?? null);
        setEstado("error");
      }
    } catch {
      setEstado("error");
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        rows={4}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        aria-label={t("configuracion.alertas.titulo")}
        aria-describedby="alertas-ayuda"
        className="w-full rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
      />
      <p id="alertas-ayuda" className="text-xs text-slate-500">
        {t("configuracion.alertas.ayuda")}
      </p>
      {horasIniciales && (
        <>
          <label htmlFor="recordatorios" className="block text-xs font-medium text-slate-700">
            {t("configuracion.recordatorios.titulo")}
          </label>
          <select
            id="recordatorios"
            value={opcion}
            onChange={(e) => setOpcion(e.target.value as Opcion | "actual")}
            aria-describedby="recordatorios-ayuda"
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
          >
            {(Object.keys(OPCIONES) as Opcion[]).map((o) => (
              <option key={o} value={o}>
                {t(`configuracion.recordatorios.${o}`)}
              </option>
            ))}
            {!opcionDe(horasIniciales) && (
              <option value="actual">
                {t("configuracion.recordatorios.actual").replace("{horas}", horasIniciales.join(", "))}
              </option>
            )}
          </select>
          <p id="recordatorios-ayuda" className="text-xs text-slate-500">
            {t("configuracion.recordatorios.ayuda")}
          </p>
        </>
      )}
      <button
        onClick={guardar}
        disabled={estado === "guardando"}
        className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {t(estado === "guardando" ? "claveIa.guardando" : "claveIa.guardar")}
      </button>
      {(estado === "ok" || estado === "error") && (
        <p
          role="status"
          className={estado === "ok" ? "text-xs text-emerald-600" : "text-xs text-red-500"}
        >
          {t(estado === "ok" ? "configuracion.alertas.guardadas" : "configuracion.alertas.error")}
          {estado === "error" && motivo && ` ${motivo}`}
        </p>
      )}
    </div>
  );
}
