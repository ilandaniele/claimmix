/**
 * StatusBadge — colored badge for case status values.
 *
 * Color mapping per AC11 spec:
 *   listo      → green-100 / green-800
 *   esperando  → yellow-100 / yellow-800
 *   escalado   → red-100 / red-800
 *   cerrado    → slate-100 / slate-800
 *   procesando → blue-100 / blue-800
 */

import type { CaseStatus } from "@/lib/schemas/cases";
import { t } from "@/lib/i18n";

interface StatusBadgeProps {
  status: CaseStatus;
}

const STATUS_CLASSES: Record<CaseStatus, string> = {
  listo: "bg-green-100 text-green-800",
  esperando: "bg-yellow-100 text-yellow-800",
  escalado: "bg-red-100 text-red-800",
  cerrado: "bg-slate-100 text-slate-800",
  procesando: "bg-blue-100 text-blue-800",
};

const STATUS_LABELS: Record<CaseStatus, string> = {
  listo: t("status.listo"),
  esperando: t("status.esperando"),
  escalado: t("status.escalado"),
  cerrado: t("status.cerrado"),
  procesando: t("status.procesando"),
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const classes = STATUS_CLASSES[status] ?? "bg-slate-100 text-slate-800";
  const label = STATUS_LABELS[status] ?? status;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}
      data-status={status}
    >
      {label}
    </span>
  );
}
