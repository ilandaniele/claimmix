/**
 * SeverityBadge — colored badge for claim severity levels.
 *
 * Color mapping:
 *   low      → gray-100 / gray-700
 *   medium   → yellow-100 / yellow-800
 *   high     → orange-100 / orange-800
 *   critical → red-100 / red-800
 */

import type { Severity } from "@/lib/schemas/cases";
import { t } from "@/lib/i18n";

interface SeverityBadgeProps {
  severity: Severity | string | null | undefined;
}

const SEVERITY_CLASSES: Record<Severity, string> = {
  low: "bg-slate-100 text-slate-700",
  medium: "bg-yellow-100 text-yellow-800",
  high: "bg-orange-100 text-orange-800",
  critical: "bg-red-100 text-red-800",
};

const SEVERITY_LABELS: Record<Severity, string> = {
  low: t("severity.low"),
  medium: t("severity.medium"),
  high: t("severity.high"),
  critical: t("severity.critical"),
};

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  if (!severity) return null;

  const classes =
    SEVERITY_CLASSES[severity as Severity] ?? "bg-slate-100 text-slate-700";
  const label = SEVERITY_LABELS[severity as Severity] ?? severity;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}
      data-severity={severity}
    >
      {label}
    </span>
  );
}
