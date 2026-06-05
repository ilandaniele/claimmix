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
import { useT } from "@/lib/i18n/LocaleContext";
import type { TranslationKey } from "@/lib/i18n";
import { ExportToCorePanel } from "./ExportToCorePanel";

interface StatusActionsProps {
  caseId: string;
  status: CaseStatus;
  caseNumber: string;
  onClose: () => void;
  onEscalate: () => void;
  onTransition: (toStatus: CaseStatus) => void;
  onReAnalyze: () => void;
  reAnalyzing: boolean;
  onError: (msg: string) => void;
  /** Whether any dialog is currently open (prevent double-clicks) */
  dialogOpen: boolean;
}

function ReAnalyzeButton({
  onReAnalyze,
  reAnalyzing,
  t,
}: {
  onReAnalyze: () => void;
  reAnalyzing: boolean;
  t: (key: TranslationKey) => string;
}) {
  return (
    <button
      type="button"
      onClick={onReAnalyze}
      disabled={reAnalyzing}
      data-testid="action-re-analizar"
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      title={t("case.detail.reAnalyze")}
    >
      {reAnalyzing ? (
        <svg
          className="w-3.5 h-3.5 animate-spin"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="w-3.5 h-3.5"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z"
            clipRule="evenodd"
          />
        </svg>
      )}
      {t("case.detail.reAnalyze")}
    </button>
  );
}

export function StatusActions({
  caseId,
  status,
  onClose,
  onEscalate,
  onTransition,
  onReAnalyze,
  reAnalyzing,
  onError,
  dialogOpen,
}: StatusActionsProps) {
  const t = useT();
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

  // ── procesando — spinner + re-analyze ─────────────────────────────────────
  if (status === "procesando") {
    return (
      <div className="flex flex-wrap items-center gap-2">
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
        <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
      </div>
    );
  }

  // ── listo — cerrar + escalar + exportar + re-analizar ─────────────────────
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
          <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
        </div>
        <ExportToCorePanel caseId={caseId} onError={onError} />
      </div>
    );
  }

  // ── esperando — marcar completo + escalar + cerrar + re-analizar ───────────
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
        <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
      </div>
    );
  }

  // ── escalado — resolver + cerrar + re-analizar ─────────────────────────────
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
        <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
      </div>
    );
  }

  // ── fallback (recibido, info_faltante, etc.) — re-analizar only ────────────
  return (
    <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
  );
}
