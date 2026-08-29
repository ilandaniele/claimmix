/**
 * FieldConfirmationsPanel — Client Component for AC21.
 *
 * Lists pending/resolved claim_field_confirmations for a case.
 * Allows analysts to confirm or reject each pending field.
 *
 * AC21: Confirm/Reject calls PATCH /api/cases/:id/confirm-field
 *       which writes audit_log FIELD_CONFIRMED with redacted values.
 * AC19: On 404 response, shows error state (case not found — IDOR defense).
 * Security: never log URLs, never expose PII from confirmations in console.
 */

"use client";

import { useState, useCallback } from "react";
import { useT } from "@/lib/i18n/LocaleContext";

interface Confirmation {
  id: string;
  field_key: string;
  proposed_value: string | null;
  conflict_with_value: string | null;
  confidence: number;
  status: "pending" | "confirmed" | "rejected" | "corrected";
  resolved_at: string | null;
}

interface FieldConfirmationsPanelProps {
  caseId: string;
  initialConfirmations: Confirmation[];
}

const STATUS_CLASSES: Record<Confirmation["status"], string> = {
  pending: "bg-amber-50 text-amber-800",
  confirmed: "bg-green-50 text-green-800",
  rejected: "bg-slate-100 text-slate-600",
  corrected: "bg-blue-50 text-blue-800",
};

/** Confidence bar — green ≥0.85, yellow 0.60–0.85, red <0.60 */
function ConfidenceIndicator({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.85
      ? "bg-green-500"
      : value >= 0.6
      ? "bg-yellow-400"
      : "bg-red-400";
  return (
    <div
      className="flex items-center gap-2"
      aria-label={`Confianza: ${pct}%`}
    >
      <div className="h-1.5 w-16 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-slate-500">{pct}%</span>
    </div>
  );
}

export function FieldConfirmationsPanel({
  caseId,
  initialConfirmations,
}: FieldConfirmationsPanelProps) {
  const t = useT();
  const STATUS_LABELS: Record<Confirmation["status"], string> = {
    pending: t("case.detail.pending"),
    confirmed: t("case.detail.confirmed"),
    rejected: t("case.detail.rejected"),
    corrected: t("case.detail.corrected"),
  };
  const [confirmations, setConfirmations] =
    useState<Confirmation[]>(initialConfirmations);
  // Track which confirmation IDs are loading
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const handleAction = useCallback(
    async (
      confirmation: Confirmation,
      action: "confirm" | "reject"
    ) => {
      setLoadingIds((prev) => new Set(prev).add(confirmation.id));
      setError(null);

      try {
        const res = await fetch(`/api/cases/${caseId}/confirm-field`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            field_key: confirmation.field_key,
            value:
              action === "confirm"
                ? confirmation.proposed_value
                : null,
            action,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          const msg =
            data?.error?.message ??
            "Error al procesar la confirmación. Intentá de nuevo.";
          setError(msg);
          return;
        }

        // Optimistic update — mark as confirmed/rejected locally
        setConfirmations((prev) =>
          prev.map((c) =>
            c.id === confirmation.id
              ? {
                  ...c,
                  status: action === "confirm" ? "confirmed" : "rejected",
                  resolved_at: new Date().toISOString(),
                }
              : c
          )
        );
      } catch {
        setError("Error de red. Intentá de nuevo.");
      } finally {
        setLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(confirmation.id);
          return next;
        });
      }
    },
    [caseId]
  );

  if (confirmations.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        {t("case.detail.noConfirmations")}
      </p>
    );
  }

  const pending = confirmations.filter((c) => c.status === "pending");
  const resolved = confirmations.filter((c) => c.status !== "pending");

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {/* Pending confirmations */}
      {pending.length > 0 && (
        <div className="space-y-3">
          {pending.map((conf) => {
            const isLoading = loadingIds.has(conf.id);
            /*
             * Sin valor propuesto no hay nada que confirmar.
             *
             * El botón se ofrecía igual y mandaba `value: null`, que el
             * servidor rechaza. Lo único que se puede hacer con un campo que el
             * agente no logró leer es rechazarlo, así que se ofrece eso.
             */
            const sinValor =
              conf.proposed_value === null || conf.proposed_value === "";
            return (
              <div
                key={conf.id}
                className="rounded-lg border border-amber-200 bg-amber-50 p-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      {t("case.detail.fieldKey")}:{" "}
                      <span className="font-mono text-slate-700 normal-case">
                        {conf.field_key}
                      </span>
                    </p>
                    <p className="text-sm text-slate-800">
                      <span className="text-slate-500">
                        {t("case.detail.proposedValue")}:{" "}
                      </span>
                      <span className="font-medium">
                        {conf.proposed_value ?? "—"}
                      </span>
                    </p>
                    {conf.conflict_with_value && (
                      <p className="text-sm text-orange-700">
                        <span>{t("case.detail.conflictValue")}: </span>
                        <span className="font-medium line-through">
                          {conf.conflict_with_value}
                        </span>
                      </p>
                    )}
                    <ConfidenceIndicator value={conf.confidence} />
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      disabled={isLoading || sinValor}
                      title={
                        sinValor
                          ? "El agente no propuso ningún valor para este campo"
                          : undefined
                      }
                      onClick={() => handleAction(conf, "confirm")}
                      className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isLoading ? "..." : t("case.detail.confirmField")}
                    </button>
                    <button
                      type="button"
                      disabled={isLoading}
                      onClick={() => handleAction(conf, "reject")}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isLoading ? "..." : t("case.detail.rejectField")}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Resolved confirmations — read-only history */}
      {resolved.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
            Historial de confirmaciones
          </p>
          <div className="space-y-2">
            {resolved.map((conf) => (
              <div
                key={conf.id}
                className="flex items-center justify-between rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs text-slate-600">
                  {conf.field_key}
                </span>
                <span className="text-slate-700 truncate mx-2 flex-1">
                  {conf.proposed_value ?? "—"}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[conf.status]}`}
                >
                  {STATUS_LABELS[conf.status]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
