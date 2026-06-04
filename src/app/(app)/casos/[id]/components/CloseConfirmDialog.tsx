/**
 * CloseConfirmDialog — modal that requires typing the case number to confirm closure.
 *
 * AC15: Dialog with:
 *   - Description: "¿Confirmar cierre del siniestro? Esta acción no puede deshacerse."
 *   - Text input: user must type the case number (e.g. "SIN-XXXX-XXXX") to enable button.
 *   - On confirm: PATCH /api/cases/:id { status: "cerrado" }.
 *   - Shows success toast and redirects to /bandeja.
 *   - On 409 FSM conflict: shows error "Transición de estado no válida."
 */

"use client";

import { useState, useRef, useEffect, useId } from "react";
import { useT } from "@/lib/i18n/LocaleContext";

interface CloseConfirmDialogProps {
  caseId: string;
  caseNumber: string;
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

type CloseReason = "paid_out" | "rejected" | "duplicate" | "cancelled";

export function CloseConfirmDialog({
  caseId,
  caseNumber,
  onClose,
  onSuccess,
  onError,
}: CloseConfirmDialogProps) {
  const t = useT();
  const CLOSE_REASONS = [
    { value: "paid_out" as CloseReason, label: t("close.reason.paid_out") },
    { value: "rejected" as CloseReason, label: t("close.reason.rejected") },
    { value: "duplicate" as CloseReason, label: t("close.reason.duplicate") },
    { value: "cancelled" as CloseReason, label: t("close.reason.cancelled") },
  ];
  const [typedNumber, setTypedNumber] = useState("");
  const [reason, setReason] = useState<CloseReason>("paid_out");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  const isConfirmEnabled = typedNumber === caseNumber && !loading;

  // Focus the input when dialog opens
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Trap focus within dialog and handle Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])'
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleConfirm() {
    if (!isConfirmEnabled) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cerrado", reason }),
      });

      if (res.ok) {
        onSuccess();
      } else if (res.status === 409) {
        onError(t("close.errorFsm"));
        onClose();
      } else {
        onError(t("close.error"));
        onClose();
      }
    } catch {
      onError(t("close.error"));
      onClose();
    } finally {
      setLoading(false);
    }
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
        {/* Header */}
        <h2 id={titleId} className="text-base font-semibold text-slate-900 mb-2">
          {t("close.title")}
        </h2>
        <p id={descId} className="text-sm text-slate-600 mb-5">
          {t("close.description")}
        </p>

        {/* Reason selector */}
        <div className="mb-4">
          <label
            htmlFor="close-reason"
            className="block text-sm font-medium text-slate-700 mb-1.5"
          >
            {t("close.reason")}
          </label>
          <select
            id="close-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as CloseReason)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-500"
            disabled={loading}
          >
            {CLOSE_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* Type-to-confirm */}
        <div className="mb-6">
          <label
            htmlFor="close-confirm-input"
            className="block text-sm font-medium text-slate-700 mb-1.5"
          >
            {t("close.typeToConfirm")}{" "}
            <span className="font-mono text-slate-900">{caseNumber}</span>
          </label>
          <input
            ref={inputRef}
            id="close-confirm-input"
            type="text"
            value={typedNumber}
            onChange={(e) => setTypedNumber(e.target.value)}
            placeholder={caseNumber}
            disabled={loading}
            autoComplete="off"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-500 disabled:bg-slate-50"
            aria-required="true"
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition-colors"
          >
            {t("close.cancel")}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!isConfirmEnabled}
            data-testid="close-confirm-button"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
            aria-disabled={!isConfirmEnabled}
          >
            {loading ? "Cerrando..." : t("close.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
