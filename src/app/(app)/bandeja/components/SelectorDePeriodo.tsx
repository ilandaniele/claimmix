"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import { useNavegacion } from "./navegacion-pendiente";
import { useFilterParam } from "./useFilterParam";
import type { Periodo } from "@/lib/schemas/cases";

const OPCIONES: { valor: Periodo | ""; etiqueta: "periodo.todo" | "periodo.hoy" | "periodo.7d" | "periodo.30d" | "periodo.90d" }[] = [
  { valor: "", etiqueta: "periodo.todo" },
  { valor: "hoy", etiqueta: "periodo.hoy" },
  { valor: "7d", etiqueta: "periodo.7d" },
  { valor: "30d", etiqueta: "periodo.30d" },
  { valor: "90d", etiqueta: "periodo.90d" },
];

/**
 * El selector de período de la bandeja: hoy, últimos 7/30/90 días, o todo.
 *
 * Un valor a la vez y no varios combinados, así que es un grupo de botones
 * con `aria-pressed` —no chips que se suman— y no pasa por `GRUPOS_DE_FILTRO`,
 * pensado para filtros que sí se combinan.
 */
export function SelectorDePeriodo() {
  const t = useT();
  const { paramsVisibles } = useNavegacion();
  const setFilter = useFilterParam();
  const activo = paramsVisibles.get("periodo") ?? "";

  return (
    <div
      role="group"
      aria-label={t("periodo.titulo")}
      className="inline-flex flex-shrink-0 rounded-lg border border-control bg-white p-0.5 shadow-sm"
    >
      {OPCIONES.map((o) => {
        const puesto = o.valor === activo;
        return (
          <button
            key={o.valor || "todo"}
            type="button"
            aria-pressed={puesto}
            onClick={() => setFilter("periodo", o.valor ? [o.valor] : [])}
            className={[
              "rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors",
              puesto
                ? "bg-violet-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
            ].join(" ")}
          >
            {t(o.etiqueta)}
          </button>
        );
      })}
    </div>
  );
}
