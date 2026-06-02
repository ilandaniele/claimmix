/**
 * StatusActions — renders FSM-aware action buttons for a case.
 *
 * AC15 button matrix:
 *   listo:      "Cerrar siniestro" (green) + "Escalar" (orange) + "Exportar al Core"
 *   esperando:  "Marcar completo" (green) + "Escalar" (orange) + "Cerrar" (gray)
 *   escalado:   "Resolver escalado → Listo" (blue) + "Cerrar" (gray)
 *   procesando: No action buttons — "Procesando..." spinner
 *   cerrado:    Read-only banner "Siniestro cerrado"
 */

"use client";

import type { CaseStatus } from "@/lib/schemas/cases";
import { t } from "@/lib/i18n";
import { ExportToCorePanel } from "./ExportToCorePanel";

interface StatusActionsProps {
  caseId: string;
  status: CaseStatus;
  caseNumber: string;
  onClose: () => void;
  onEscalate: () => void;
  onTransition: (toStatus: CaseStatus) => void;
  onError: (msg: string) => void;
  /** Whether any dialog is currently open (prevent double-clicks) */
  dialogOpen: boolean;
}

export function StatusActions({
  caseId,
  status,
  onClose,
  onEscalate,
  onTransition,
  onError,
  dialogOpen,
}: StatusActionsProps) {
  // ── cerrado — read-only banner ──────────────────────────────────────────────
  if (status === "cerrado") {
    return (
      <div
        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-600"
        role="status"
        aria-label={t("case.detail.closedBanner")}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="w-4 h-4 text-slate-400"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
            clipRule="evenodd"
          />
        </svg>
        {t("case.detail.closedBanner")}
      </div>
    );
  }

  // ── procesando — spinner, no actions ───────────────────────────────────────
  if (status === "procesando") {
    return (
      <div
        className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700"
        role="status"
        aria-label={t("case.detail.processing")}
        aria-live="polite"
      >
        <svg
          className="w-4 h-4 animate-spin text-blue-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        {t("case.detail.processing")}
      </div>
    );
  }

  // ── listo — cerrar + escalar + exportar ────────────────────────────────────
  if (status === "listo") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={dialogOpen}
            data-testid="action-cerrar"
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t("case.detail.close")}
          </button>
          <button
            type="button"
            onClick={onEscalate}
            disabled={dialogOpen}
            data-testid="action-escalar"
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t("case.detail.escalate")}
          </button>
        </div>
        <ExportToCorePanel caseId={caseId} onError={onError} />
      </div>
    );
  }

  // ── esperando — marcar completo + escalar + cerrar ─────────────────────────
  if (status === "esperando") {
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onTransition("listo")}
          disabled={dialogOpen}
          data-testid="action-marcar-completo"
          className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("case.detail.markComplete")}
        </button>
        <button
          type="button"
          onClick={onEscalate}
          disabled={dialogOpen}
          data-testid="action-escalar"
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("case.detail.escalate")}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={dialogOpen}
          data-testid="action-cerrar"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("case.detail.close")}
        </button>
      </div>
    );
  }

  // ── escalado — resolver + cerrar ───────────────────────────────────────────
  if (status === "escalado") {
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onTransition("listo")}
          disabled={dialogOpen}
          data-testid="action-resolver-escalado"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("case.detail.resolveEscalated")}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={dialogOpen}
          data-testid="action-cerrar"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("case.detail.close")}
        </button>
      </div>
    );
  }

  // Fallback — should not be reached
  return null;
}
