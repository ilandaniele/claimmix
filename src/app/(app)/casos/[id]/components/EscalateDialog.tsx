/**
 * EscalateDialog — simple confirmation dialog for escalating a case.
 *
 * AC15: Simple confirm dialog with optional textarea for escalation reason (max 500 chars).
 *   - PATCH /api/cases/:id { status: "escalado" }
 *   - Audit log entry includes escalation reason.
 */

"use client";

import { useState, useRef, useEffect, useId } from "react";
import { t } from "@/lib/i18n";

interface EscalateDialogProps {
  caseId: string;
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

const MAX_REASON_LENGTH = 500;

export function EscalateDialog({
  caseId,
  onClose,
  onSuccess,
  onError,
}: EscalateDialogProps) {
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  // Focus textarea when dialog opens
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Escape closes the dialog; Tab is trapped
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])'
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
    setLoading(true);
    try {
      const body: { status: string; reason?: string } = { status: "escalado" };
      if (reason.trim()) {
        body.reason = reason.trim();
      }

      const res = await fetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        onSuccess();
      } else if (res.status === 409) {
        onError("Transición de estado no válida.");
        onClose();
      } else {
        onError(t("escalate.error"));
        onClose();
      }
    } catch {
      onError(t("escalate.error"));
      onClose();
    } finally {
      setLoading(false);
    }
  }

  const charsLeft = MAX_REASON_LENGTH - reason.length;

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
          {t("escalate.title")}
        </h2>
        <p id={descId} className="text-sm text-slate-600 mb-5">
          {t("escalate.description")}
        </p>

        {/* Optional reason textarea */}
        <div className="mb-6">
          <label
            htmlFor="escalate-reason"
            className="block text-sm font-medium text-slate-700 mb-1.5"
          >
            {t("escalate.reason")}{" "}
            <span className="text-slate-400 font-normal">(opcional)</span>
          </label>
          <textarea
            ref={textareaRef}
            id="escalate-reason"
            value={reason}
            onChange={(e) =>
              setReason(e.target.value.slice(0, MAX_REASON_LENGTH))
            }
            placeholder={t("escalate.reasonPlaceholder")}
            disabled={loading}
            rows={4}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:bg-slate-50 resize-none"
            aria-describedby="escalate-chars-left"
          />
          <p
            id="escalate-chars-left"
            className="mt-1 text-xs text-slate-400 text-right"
            aria-live="polite"
          >
            {charsLeft} caracteres restantes
          </p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition-colors"
          >
            {t("escalate.cancel")}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            data-testid="escalate-confirm-button"
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Escalando..." : t("escalate.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
