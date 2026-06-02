/**
 * TypeFilterChips — claim type filter chips.
 *
 * Chips per AC11: Todos | Choque | Robo | Granizo | Incendio
 * Clicking changes the URL search param "type".
 */

"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";
import { t } from "@/lib/i18n";
import type { ClaimType } from "@/lib/schemas/cases";

interface TypeFilterChipsProps {
  activeType: ClaimType | undefined;
}

const CHIPS: { key: ClaimType | "todos"; label: string }[] = [
  { key: "todos", label: t("type.todos") },
  { key: "choque", label: t("type.choque") },
  { key: "robo", label: t("type.robo") },
  { key: "granizo", label: t("type.granizo") },
  { key: "incendio", label: t("type.incendio") },
];

export function TypeFilterChips({ activeType }: TypeFilterChipsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleChipClick = useCallback(
    (type: ClaimType | "todos") => {
      const params = new URLSearchParams(searchParams.toString());
      if (type === "todos") {
        params.delete("type");
      } else {
        params.set("type", type);
      }
      // Reset to page 1 when changing type filter
      params.delete("page");
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  return (
    <div
      role="group"
      aria-label="Filtrar por tipo de siniestro"
      className="flex items-center gap-2 flex-wrap"
    >
      {CHIPS.map(({ key, label }) => {
        const isActive =
          key === "todos" ? !activeType : activeType === key;

        return (
          <button
            key={key}
            onClick={() => handleChipClick(key)}
            aria-pressed={isActive}
            className={[
              "rounded-full px-3 py-1 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
              isActive
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900",
            ].join(" ")}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
