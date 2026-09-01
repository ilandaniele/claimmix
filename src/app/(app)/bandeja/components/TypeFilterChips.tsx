"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useFilterParam } from "./useFilterParam";
import { claseChip } from "./chip";
import { useCallback } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import type { ClaimType } from "@/lib/schemas/cases";

interface TypeFilterChipsProps {
  activeType: ClaimType | undefined;
}

export function TypeFilterChips({ activeType }: TypeFilterChipsProps) {
  const t = useT();
  const setFilter = useFilterParam();

  const CHIPS: { key: ClaimType | "todos"; label: string }[] = [
    { key: "todos", label: t("type.todos") },
    { key: "choque", label: t("type.choque") },
    { key: "robo", label: t("type.robo") },
    { key: "granizo", label: t("type.granizo") },
    { key: "incendio", label: t("type.incendio") },
    { key: "cristales", label: t("type.cristales") },
    { key: "rc", label: t("type.rc") },
    { key: "robo_contenido", label: t("type.robo_contenido") },
    { key: "accidente_personal", label: t("type.accidente_personal") },
  ];

  const handleChipClick = useCallback(
      (type: ClaimType | "todos") => {
        setFilter("type", type === "todos" ? null : type);
      },
      [setFilter]
    );

  return (
    <div
      role="group"
      aria-label={t("filter.isClaim")}
      className="flex flex-wrap items-center gap-1"
    >
      {CHIPS.map(({ key, label }) => {
        const isActive =
          key === "todos" ? !activeType : activeType === key;

        return (
          <button
            key={key}
            onClick={() => handleChipClick(key)}
            aria-pressed={isActive}
            className={claseChip(isActive)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
