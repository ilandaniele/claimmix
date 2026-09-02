/**
 * ConfidenceBar — displays confidence score as a percentage.
 *
 * Color coding per AC11:
 *   ≥ 70%  → green text
 *   50–69% → yellow text
 *   < 50%  → red text
 *   null   → dash (case still procesando)
 */

"use client";

import { useT } from "@/lib/i18n/LocaleContext";

import { Vacio } from "./Vacio";

interface ConfidenceBarProps {
  value: number | null;
}

function getColorClass(value: number): string {
  if (value >= 0.7) return "text-green-700 font-medium";
  if (value >= 0.5) return "text-yellow-700 font-medium";
  return "text-red-700 font-medium";
}

export function ConfidenceBar({ value }: ConfidenceBarProps) {
  const t = useT();

  if (value === null || value === undefined) {
    return <Vacio />;
  }

  const pct = Math.round(value * 100);
  const colorClass = getColorClass(value);

  return (
    <span className={`text-sm tabular-nums ${colorClass}`} aria-label={t("confianza.aria").replace("{n}", String(pct))}>
      {pct}%
    </span>
  );
}
