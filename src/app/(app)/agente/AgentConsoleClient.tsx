"use client";

import { useState } from "react";
import { Brain, CheckCircle2, ListChecks, Settings2, SlidersHorizontal } from "lucide-react";

import { AiProviderPanel } from "../configuracion/AiProviderPanel";
import { PromptRulesPanel } from "../configuracion/PromptRulesPanel";
import { CustomFieldsPanel } from "./CustomFieldsPanel";
import { TrainingExamplesPanel } from "./TrainingExamplesPanel";
import { FineTuneJobsPanel } from "./FineTuneJobsPanel";
import { AgentExportPanel } from "./AgentExportPanel";

type TabId = "modelos" | "campos" | "reglas" | "ejemplos" | "entrenamiento";

const TABS = [
  { id: "modelos", label: "Modelos", icon: Settings2 },
  { id: "campos", label: "Campos personalizados", icon: SlidersHorizontal },
  { id: "reglas", label: "Reglas de prompt", icon: ListChecks },
  { id: "ejemplos", label: "Ejemplos aprobados", icon: CheckCircle2 },
  { id: "entrenamiento", label: "Fine-tuning opcional", icon: Brain },
] as const;

export function AgentConsoleClient({ role }: { role: string }) {
  const [tab, setTab] = useState<TabId>("modelos");

  return (
    <div className="space-y-5">
      <AgentExportPanel role={role} />

      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map(({ id, label, icon: Icon }) => {
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
              {label}
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
      </div>
    </div>
  );
}
