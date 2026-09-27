/**
 * TomarElControlDialog — confirmación simple para «tomar el control» (D-F2).
 *
 * Sólo avisa que es un paso de un solo sentido; no pide escribir nada. El
 * PATCH lo manda `onConfirm`, que en `CaseDetailClient` es el mismo `accion()`
 * que usan las demás transiciones, con `{409: "close.errorFsm"}`.
 */

"use client";

import { useId } from "react";

import { useDialogoModal } from "../../../_components/dialogo-modal";
import { useT } from "@/lib/i18n/LocaleContext";

interface TomarElControlDialogProps {
  onClose: () => void;
  onConfirm: () => void;
}

export function TomarElControlDialog({ onClose, onConfirm }: TomarElControlDialogProps) {
  const t = useT();
  const dialogRef = useDialogoModal<HTMLDivElement>(onClose);
  const titleId = useId();
  const descId = useId();

  function handleConfirm() {
    onConfirm();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
      >
        <h2 id={titleId} className="text-base font-semibold text-slate-900 mb-2">
          {t("tomarElControl.title")}
        </h2>
        <p id={descId} className="text-sm text-slate-600 mb-6">
          {t("tomarElControl.description")}
        </p>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 transition-colors"
          >
            {t("tomarElControl.cancel")}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            data-testid="tomar-el-control-confirm-button"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            {t("tomarElControl.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
