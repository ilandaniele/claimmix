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
      className="flex items-center gap-1 border-b border-slate-200 pb-px"
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
              "flex items-center gap-1.5 rounded-t-md px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
              isActive
                ? "border-b-2 border-slate-900 text-slate-900"
                : "text-slate-500 hover:text-slate-700",
            ].join(" ")}
          >
            {label}
            <span
              className={[
                "rounded-full px-1.5 py-0.5 text-xs tabular-nums",
                isActive
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600",
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
