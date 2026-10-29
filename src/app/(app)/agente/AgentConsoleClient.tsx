"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

import { useT } from "@/lib/i18n/LocaleContext";
import { useTeclasDePestanas } from "@/lib/ui/pestanas";

import { AiProviderPanel } from "../configuracion/AiProviderPanel";
import { PromptRulesPanel } from "../configuracion/PromptRulesPanel";
import { CustomFieldsPanel } from "./CustomFieldsPanel";
import { TrainingExamplesPanel } from "./TrainingExamplesPanel";
import { FineTuneJobsPanel } from "./FineTuneJobsPanel";
import { TrabajoPanel } from "./TrabajoPanel";
import { AgentExportPanel } from "./AgentExportPanel";
import { ProviderUsagePanel } from "./ProviderUsagePanel";
import { BatchSimulatePanel } from "./BatchSimulatePanel";
import { TABS, type TabId } from "./pestanas-de-la-consola";

/** `aria-controls` necesita un id, y el panel es uno solo para todas. */
const ID_PANEL = "panel-de-la-consola";

/**
 * Siete botones que decían ser pestañas sin serlo.
 *
 * No había `role="tablist"`, ni `role="tab"`, ni `aria-selected`, ni
 * `role="tabpanel"`, ni flechas: los siete estaban en el orden de tabulación,
 * que es como se comporta un grupo de botones sueltos. Un lector de pantalla
 * anunciaba siete botones y el cambio de panel no se anunciaba en absoluto —
 * la persona apretaba uno y, por lo que oía, no pasaba nada.
 *
 * `FilterTabs` de la bandeja ya tenía el patrón entero. Las teclas ahora viven
 * en `@/lib/ui/pestanas`, compartidas por las dos, para que no terminen siendo
 * dos tablist con teclados distintos.
 *
 * `ramos`, `formulario` y `base` llegan armados por el servidor: son formularios
 * nativos o texto que no necesitan estado de cliente, y así no suman JS.
 */
export function AgentConsoleClient({
  role,
  tabInicial,
  ramos,
  formulario,
  base,
}: {
  role: string;
  tabInicial?: TabId;
  ramos: ReactNode;
  formulario: ReactNode;
  base: ReactNode;
}) {
  const [tab, setTab] = useState<TabId>(tabInicial ?? "modelos");
  const t = useT();
  const lista = useRef<HTMLDivElement>(null);

  const indiceActivo = TABS.findIndex(({ id }) => id === tab);
  const elegir = useCallback((i: number) => setTab(TABS[i]!.id), []);
  const alApretarTecla = useTeclasDePestanas({
    cantidad: TABS.length,
    indiceActivo,
    elegir,
    lista,
  });

  return (
    <div className="space-y-5">
      <AgentExportPanel role={role} />

      <div
        ref={lista}
        role="tablist"
        aria-label={t("consola.pestanas")}
        onKeyDown={alApretarTecla}
        className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800"
      >
        {TABS.map(({ id, clave, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`pestana-${id}`}
              aria-selected={active}
              aria-controls={ID_PANEL}
              // Foco itinerante: sólo la activa entra al orden de tabulación.
              // Un Tab lleva al grupo entero, no a cada pestaña de a una, que
              // es justo lo que distingue un tablist de siete botones sueltos.
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(id)}
              className={[
                "inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium",
                active
                  ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
              ].join(" ")}
            >
              <Icon size={15} />
              {t(clave)}
            </button>
          );
        })}
      </div>

      <div
        id={ID_PANEL}
        role="tabpanel"
        aria-labelledby={`pestana-${tab}`}
        // El panel recibe el foco cuando se llega por teclado y no hay nada
        // enfocable adentro; con contenido enfocable, el Tab desde la pestaña
        // cae acá igual.
        tabIndex={0}
        className="rounded-lg border border-slate-200 bg-white p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-slate-800 dark:bg-slate-900/70"
      >
        {tab === "modelos" && <AiProviderPanel />}
        {tab === "campos" && <CustomFieldsPanel />}
        {tab === "ramos" && ramos}
        {tab === "formulario" && formulario}
        {tab === "reglas" && <PromptRulesPanel />}
        {tab === "ejemplos" && <TrainingExamplesPanel />}
        {tab === "entrenamiento" && <FineTuneJobsPanel />}
        {tab === "uso" && <ProviderUsagePanel />}
        {tab === "lote" && <BatchSimulatePanel />}
        {tab === "trabajo" && <TrabajoPanel />}
        {tab === "base" && base}
      </div>
    </div>
  );
}
