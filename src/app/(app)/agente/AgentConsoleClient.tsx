"use client";

import { useState } from "react";
import { Activity, Brain, CheckCircle2, ListChecks, Settings2, SlidersHorizontal, Layers } from "lucide-react";

import { useT } from "@/lib/i18n/LocaleContext";
import type { TranslationKey } from "@/lib/i18n";

import { AiProviderPanel } from "../configuracion/AiProviderPanel";
import { PromptRulesPanel } from "../configuracion/PromptRulesPanel";
import { CustomFieldsPanel } from "./CustomFieldsPanel";
import { TrainingExamplesPanel } from "./TrainingExamplesPanel";
import { FineTuneJobsPanel } from "./FineTuneJobsPanel";
import { AgentExportPanel } from "./AgentExportPanel";
import { ProviderUsagePanel } from "./ProviderUsagePanel";
import { BatchSimulatePanel } from "./BatchSimulatePanel";

type TabId = "modelos" | "campos" | "reglas" | "ejemplos" | "entrenamiento" | "uso" | "lote";

/**
 * La etiqueta es una CLAVE, no un texto: la lista se arma una sola vez cuando
 * carga el módulo, y ahí todavía no hay locale ni hook. Traducir en el `map`,
 * que sí corre dentro del componente, es lo que hace que las solapas cambien
 * de idioma sin recargar.
 */
const TABS = [
  { id: "modelos", clave: "consola.tab.modelos", icon: Settings2 },
  { id: "campos", clave: "consola.tab.campos", icon: SlidersHorizontal },
  { id: "reglas", clave: "consola.tab.reglas", icon: ListChecks },
  { id: "ejemplos", clave: "consola.tab.ejemplos", icon: CheckCircle2 },
  { id: "entrenamiento", clave: "consola.tab.entrenamiento", icon: Brain },
  { id: "uso", clave: "consola.tab.uso", icon: Activity },
  { id: "lote", clave: "consola.tab.lote", icon: Layers },
] as const satisfies readonly { id: TabId; clave: TranslationKey; icon: unknown }[];

export function AgentConsoleClient({ role }: { role: string }) {
  const [tab, setTab] = useState<TabId>("modelos");
  const t = useT();

  return (
    <div className="space-y-5">
      <AgentExportPanel role={role} />

      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map(({ id, clave, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
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

      <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/70">
        {tab === "modelos" && <AiProviderPanel />}
        {tab === "campos" && <CustomFieldsPanel />}
        {tab === "reglas" && <PromptRulesPanel />}
        {tab === "ejemplos" && <TrainingExamplesPanel />}
        {tab === "entrenamiento" && <FineTuneJobsPanel />}
        {tab === "uso" && <ProviderUsagePanel />}
        {tab === "lote" && <BatchSimulatePanel />}
      </div>
    </div>
  );
}
