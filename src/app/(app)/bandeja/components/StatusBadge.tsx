"use client";

import type { CaseStatus } from "@/lib/schemas/cases";
import { useT } from "@/lib/i18n/LocaleContext";

interface StatusBadgeProps {
  status: CaseStatus;
}

const STATUS_CLASSES: Record<CaseStatus, string> = {
  listo: "bg-green-100 text-green-800",
  esperando: "bg-yellow-100 text-yellow-800",
  escalado: "bg-red-100 text-red-800",
  cerrado: "bg-slate-100 text-slate-800",
  procesando: "bg-blue-100 text-blue-800",
  recibido: "bg-sky-100 text-sky-800",
  info_faltante: "bg-amber-100 text-amber-800",
  confirmacion_pendiente: "bg-orange-100 text-orange-800",
  requiere_especialista: "bg-rose-100 text-rose-800",
  listo_para_core: "bg-emerald-100 text-emerald-800",
  enviado_a_core: "bg-teal-100 text-teal-800",
  error_core: "bg-red-100 text-red-800",
  no_relevante: "bg-slate-100 text-slate-600",
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const t = useT();
  const classes = STATUS_CLASSES[status] ?? "bg-slate-100 text-slate-800";

  const STATUS_LABELS: Record<CaseStatus, string> = {
    listo: t("status.listo"),
    esperando: t("status.esperando"),
    escalado: t("status.escalado"),
    cerrado: t("status.cerrado"),
    procesando: t("status.procesando"),
    recibido: t("status.recibido"),
    info_faltante: t("status.info_faltante"),
    confirmacion_pendiente: t("status.confirmacion_pendiente"),
    requiere_especialista: t("status.requiere_especialista"),
    listo_para_core: t("status.listo_para_core"),
    enviado_a_core: t("status.enviado_a_core"),
    error_core: t("status.error_core"),
    no_relevante: t("status.no_relevante"),
  };

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
