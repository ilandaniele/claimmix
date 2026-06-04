"use client";

import type { Severity } from "@/lib/schemas/cases";
import { useT } from "@/lib/i18n/LocaleContext";

interface SeverityBadgeProps {
  severity: Severity | string | null | undefined;
}

const SEVERITY_CLASSES: Record<Severity, string> = {
  low: "bg-slate-100 text-slate-700",
  medium: "bg-yellow-100 text-yellow-800",
  high: "bg-orange-100 text-orange-800",
  critical: "bg-red-100 text-red-800",
};

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  const t = useT();
  if (!severity) return null;

  const SEVERITY_LABELS: Record<Severity, string> = {
    low: t("severity.low"),
    medium: t("severity.medium"),
    high: t("severity.high"),
    critical: t("severity.critical"),
  };

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
