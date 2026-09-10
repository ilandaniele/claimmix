"use client";

import { useCallback, useMemo, useRef } from "react";
import { useFilterParam } from "./useFilterParam";
import { useT } from "@/lib/i18n/LocaleContext";
import type { CaseStatus } from "@/lib/schemas/cases";
import { useTeclasDePestanas } from "@/lib/ui/pestanas";

/**
 * El id del contenedor de la lista, que es el panel de estas pestañas.
 *
 * Vive acá y no en `DashboardClient` porque el que tiene que apuntarle es el
 * `aria-controls` de cada pestaña: si el id se escribiera en los dos lados, el
 * día que cambie uno el otro apunta a la nada y nadie se entera.
 */
export const ID_PANEL_DE_LA_LISTA = "lista-de-siniestros";

interface StatusCount {
  status: CaseStatus | "todos";
  count: number;
}

interface FilterTabsProps {
  counts: StatusCount[];
  activeStatus: CaseStatus | undefined;
}

/**
 * Las pestañas de estado de la bandeja.
 *
 * ── Eran pestañas a medias ──────────────────────────────────────────────────
 *
 * Declaraban `role="tablist"` y `role="tab"` con `aria-selected`, pero no había
 * `role="tabpanel"`, ni `aria-controls`, ni foco itinerante, ni flechas. Los
 * seis botones estaban todos en el orden de tabulación, que es como se comporta
 * un grupo de botones y no un tablist.
 *
 * Eso no es un detalle de purismo: es una promesa que la interfaz no cumplía.
 * Un lector de pantalla anuncia «pestaña 2 de 6», la persona aprieta la flecha
 * derecha —que es como se navegan las pestañas— y no pasa nada. Peor que no
 * haber dicho nunca que eran pestañas.
 *
 * Ahora el patrón está completo: una sola pestaña en el orden de tabulación (la
 * activa), flechas para moverse entre ellas, Inicio y Fin para ir a los
 * extremos, y `aria-controls` apuntando a la lista, que declara `role="tabpanel"`.
 *
 * Se eligen al moverse (activación automática), que es lo que corresponde
 * cuando mostrar el panel es barato: acá filtrar es un empujón de URL y la
 * pantalla ya tiene su barra de espera.
 */
export function FilterTabs({ counts, activeStatus }: FilterTabsProps) {
  const t = useT();
  const setFilter = useFilterParam();
  const listaRef = useRef<HTMLDivElement>(null);

  /*
   * En `useMemo` porque ahora lo lee un `useCallback`: un arreglo nuevo en cada
   * render volveria a armar el manejador de teclas en cada render tambien.
   */
  const TABS = useMemo<{ key: CaseStatus | "todos"; label: string }[]>(
    () => [
      { key: "todos", label: t("tabs.todos") },
      { key: "listo", label: t("tabs.listo") },
      { key: "esperando", label: t("tabs.esperando") },
      { key: "escalado", label: t("tabs.escalado") },
      { key: "procesando", label: t("tabs.procesando") },
      { key: "cerrado", label: t("tabs.cerrado") },
    ],
    [t]
  );

  const handleTabClick = useCallback(
    (status: CaseStatus | "todos") => {
      setFilter("status", status === "todos" ? null : status);
    },
    [setFilter]
  );

  const indiceActivo = TABS.findIndex(({ key }) =>
    key === "todos" ? !activeStatus : activeStatus === key
  );

  /*
   * Las teclas viven en `@/lib/ui/pestanas`, compartidas con la consola del
   * agente, que tenía siete botones diciendo ser pestañas sin serlo. Estaban
   * escritas acá y copiarlas allá es cómo terminan dos tablist con teclados
   * distintos.
   */
  const elegir = useCallback(
    (i: number) => handleTabClick(TABS[i]!.key),
    [TABS, handleTabClick]
  );
  const alApretarTecla = useTeclasDePestanas({
    cantidad: TABS.length,
    indiceActivo,
    elegir,
    lista: listaRef,
  });

  const countMap = new Map(counts.map((c) => [c.status, c.count]));

  return (
    <div
      ref={listaRef}
      role="tablist"
      // Estaba escrito a mano en castellano, igual que el «{n} casos» de abajo:
      // con la interfaz en inglés, un lector leía la mitad en cada idioma.
      aria-label={t("tabs.filtrarPorEstado")}
      onKeyDown={alApretarTecla}
      className="-mb-px flex items-center gap-1 overflow-x-auto"
    >
      {TABS.map(({ key, label }, i) => {
        const isActive = i === indiceActivo;
        const count = countMap.get(key) ?? 0;

        return (
          <button
            key={key}
            role="tab"
            aria-selected={isActive}
            aria-controls={ID_PANEL_DE_LA_LISTA}
            /*
             * Foco itinerante: sólo la activa entra al orden de tabulación. Un
             * Tab lleva al grupo entero, no a cada pestaña de a una, que es
             * justo lo que distingue un tablist de seis botones sueltos.
             */
            tabIndex={isActive ? 0 : -1}
            onClick={() => handleTabClick(key)}
            className={[
              // `border-b-2` en los dos estados, transparente cuando no esta
              // activo: si solo lo lleva el activo, la pestana crece dos pixeles
              // al seleccionarla y la fila entera salta.
              "flex flex-shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
              isActive
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-slate-500 hover:text-slate-900",
            ].join(" ")}
          >
            {label}
            <span
              className={[
                "cifra rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                isActive
                  ? "bg-violet-600 text-white"
                  : "bg-slate-100 text-slate-600",
              ].join(" ")}
              aria-label={`${count} ${t("bandeja.claims")}`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
