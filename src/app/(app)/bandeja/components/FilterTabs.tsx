"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useFilterParam } from "./useFilterParam";
import { useCallback } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import type { CaseStatus } from "@/lib/schemas/cases";

interface StatusCount {
  status: CaseStatus | "todos";
  count: number;
}

interface FilterTabsProps {
  counts: StatusCount[];
  activeStatus: CaseStatus | undefined;
}

export function FilterTabs({ counts, activeStatus }: FilterTabsProps) {
  const t = useT();
  const setFilter = useFilterParam();

  const TABS: { key: CaseStatus | "todos"; label: string }[] = [
    { key: "todos", label: t("tabs.todos") },
    { key: "listo", label: t("tabs.listo") },
    { key: "esperando", label: t("tabs.esperando") },
    { key: "escalado", label: t("tabs.escalado") },
    { key: "procesando", label: t("tabs.procesando") },
    { key: "cerrado", label: t("tabs.cerrado") },
  ];

  const handleTabClick = useCallback(
      (status: CaseStatus | "todos") => {
        setFilter("status", status === "todos" ? null : status);
      },
      [setFilter]
    );

  const countMap = new Map(counts.map((c) => [c.status, c.count]));

  return (
    <div
      role="tablist"
      aria-label="Filtrar por estado"
      className="-mb-px flex items-center gap-1 overflow-x-auto"
    >
      {TABS.map(({ key, label }) => {
        const isActive =
          key === "todos" ? !activeStatus : activeStatus === key;
        const count = countMap.get(key) ?? 0;

        return (
          <button
            key={key}
            role="tab"
            aria-selected={isActive}
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
                "cifra rounded-full px-1.5 py-0.5 text-[11px]",
                isActive
                  ? "bg-violet-100 text-violet-700"
                  : "bg-slate-100 text-slate-500",
              ].join(" ")}
              aria-label={`${count} casos`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
