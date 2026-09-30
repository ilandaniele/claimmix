"use client";

import { useState } from "react";

import type { RangosDeMonto } from "@/core/case/monto-estimado";
import { useT } from "@/lib/i18n/LocaleContext";

interface Props {
  /** La tabla propia del tenant; null: usa la de por defecto. */
  inicial: RangosDeMonto | null;
  porDefecto: RangosDeMonto;
}

const GRAVEDADES = ["low", "medium", "high", "critical"] as const;
type Tipo = keyof RangosDeMonto;
type Celdas = Record<string, string>;
type Lado = "minimo" | "maximo";

function celdasDe(rangos: RangosDeMonto, tipos: readonly Tipo[]): Celdas {
  const celdas: Celdas = {};
  for (const tipo of tipos) {
    for (const g of GRAVEDADES) {
      const r = rangos[tipo]?.[g];
      celdas[`${tipo}.${g}.minimo`] = r ? String(r.minimo) : "";
      celdas[`${tipo}.${g}.maximo`] = r ? String(r.maximo) : "";
    }
  }
  return celdas;
}

/**
 * Los montos orientativos por tipo y gravedad (B23), editables por un admin.
 *
 * Valida el servidor. Este panel no importa zod ni el módulo de montos: la
 * tabla por defecto le llega como prop, y del núcleo sólo usa tipos.
 */
export function MontosPanel({ inicial, porDefecto }: Props) {
  const t = useT();
  const tipos = Object.keys(porDefecto) as Tipo[];
  // Sólo lo propio va en las celdas: el valor por defecto se ve de fondo y,
  // si no se toca, sigue el de por defecto aunque ese cambie.
  const [celdas, setCeldas] = useState<Celdas>(() => celdasDe(inicial ?? {}, tipos));
  const [estado, setEstado] = useState<"idle" | "guardando" | "ok" | "error">("idle");
  const [motivo, setMotivo] = useState<string | null>(null);

  async function enviar(rangos: RangosDeMonto | null) {
    setEstado("guardando");
    setMotivo(null);
    try {
      const res = await fetch("/api/admin/montos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rangos }),
      });
      if (res.ok) {
        if (rangos === null) setCeldas(celdasDe({}, tipos));
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

  function guardar() {
    const rangos: RangosDeMonto = {};
    for (const tipo of tipos) {
      for (const g of GRAVEDADES) {
        const celda = (lado: Lado) => celdas[`${tipo}.${g}.${lado}`] ?? "";
        if (!celda("minimo") && !celda("maximo")) continue;
        // Media celda vacía usa su lado por defecto, como dice la ayuda.
        const valor = (lado: Lado) => Number(celda(lado) || porDefecto[tipo]?.[g]?.[lado]);
        rangos[tipo] = { ...rangos[tipo], [g]: { minimo: valor("minimo"), maximo: valor("maximo") } };
      }
    }
    void enviar(rangos);
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">{t("configuracion.montos.ayuda")}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 pr-2 font-medium">{t("configuracion.montos.tipo")}</th>
              {GRAVEDADES.map((g) => (
                <th key={g} className="py-1 pr-2 font-medium">
                  {t(`severity.${g}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tipos.map((tipo) => (
              <tr key={tipo} className="border-t border-slate-100">
                <td className="py-1 pr-2 text-slate-700">{t(`type.${tipo}`)}</td>
                {GRAVEDADES.map((g) => (
                  <td key={g} className="py-1 pr-2">
                    <div className="flex gap-1">
                      {(["minimo", "maximo"] as const).map((lado) => {
                        const clave = `${tipo}.${g}.${lado}`;
                        return (
                          <input
                            key={lado}
                            type="number"
                            min={0}
                            step={1000}
                            value={celdas[clave] ?? ""}
                            placeholder={String(porDefecto[tipo]?.[g]?.[lado] ?? "")}
                            onChange={(e) => setCeldas((c) => ({ ...c, [clave]: e.target.value }))}
                            aria-label={`${t(`type.${tipo}`)} · ${t(`severity.${g}`)} · ${t(`configuracion.montos.${lado}`)}`}
                            className="w-24 rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-slate-800 focus:border-blue-500 focus:outline-none"
                          />
                        );
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
          disabled={estado === "guardando"}
          className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {t("configuracion.montos.restaurar")}
        </button>
      </div>
      {(estado === "ok" || estado === "error") && (
        <p role="status" className={estado === "ok" ? "text-xs text-emerald-600" : "text-xs text-red-500"}>
          {t(estado === "ok" ? "configuracion.montos.guardados" : "configuracion.montos.error")}
          {estado === "error" && motivo && ` ${motivo}`}
        </p>
      )}
    </div>
  );
}
