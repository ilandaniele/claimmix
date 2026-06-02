/**
 * SimulateModal — "Simular nuevo email" modal.
 *
 * AC13: Allows selecting a pre-seeded scenario (20 total) or entering custom text.
 * On submit: calls POST /api/intake/simulate, shows loading/success/error state.
 * Rate limit feedback: shows Spanish message if 429 returned.
 */

"use client";

import { useState, useCallback } from "react";
import type { SimulationScenario } from "@/server/intake/scenarios";
import type { ClaimType } from "@/lib/schemas/cases";
import { t } from "@/lib/i18n";

interface SimulateModalProps {
  scenarios: SimulationScenario[];
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

type InputMode = "scenario" | "custom";

const CLAIM_TYPES: { value: ClaimType; label: string }[] = [
  { value: "choque", label: t("simulate.scenario.choque") },
  { value: "robo", label: t("simulate.scenario.robo") },
  { value: "granizo", label: t("simulate.scenario.granizo") },
  { value: "incendio", label: t("simulate.scenario.incendio") },
];

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

export function SimulateModal({
  scenarios,
  onClose,
  onSuccess,
  onError,
}: SimulateModalProps) {
  const [mode, setMode] = useState<InputMode>("scenario");
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>(
    scenarios[0]?.id ?? ""
  );
  const [customText, setCustomText] = useState("");
  const [customType, setCustomType] = useState<ClaimType>("choque");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);

    try {
      let body: Record<string, unknown>;

      if (mode === "scenario") {
        if (!selectedScenarioId) {
          onError("Seleccioná un escenario.");
          setSubmitting(false);
          return;
        }
        body = { scenario_id: selectedScenarioId };
      } else {
        if (!customText.trim()) {
          onError("Ingresá el texto del siniestro.");
          setSubmitting(false);
          return;
        }
        body = { raw_text: customText.trim(), case_type: customType };
      }

      const res = await fetch("/api/intake/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        onError("Demasiadas simulaciones. Espere un momento.");
        onClose();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg =
          (data as { error?: { message?: string } })?.error?.message ??
          t("simulate.error");
        onError(msg);
        onClose();
        return;
      }

      onSuccess("Procesando siniestro...");
      onClose();
    } catch {
      onError(t("simulate.error"));
      onClose();
    } finally {
      setSubmitting(false);
    }
  }, [mode, selectedScenarioId, customText, customType, onClose, onSuccess, onError]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="simulate-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleBackdropClick}
    >
      <div className="relative w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        {/* Title */}
        <h2
          id="simulate-modal-title"
          className="text-lg font-semibold text-slate-900 mb-4"
        >
          {t("simulate.title")}
        </h2>

        {/* Mode selector */}
        <div className="flex gap-2 mb-4">
          <button
            type="button"
            onClick={() => setMode("scenario")}
            className={[
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              mode === "scenario"
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200",
            ].join(" ")}
          >
            Escenario pre-cargado
          </button>
          <button
            type="button"
            onClick={() => setMode("custom")}
            className={[
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              mode === "custom"
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200",
            ].join(" ")}
          >
            Texto personalizado
          </button>
        </div>

        {/* Scenario picker */}
        {mode === "scenario" && (
          <div className="mb-4">
            <label
              htmlFor="scenario-select"
              className="block text-sm font-medium text-slate-700 mb-1"
            >
              Escenario
            </label>
            <select
              id="scenario-select"
              value={selectedScenarioId}
              onChange={(e) => setSelectedScenarioId(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.case_type.charAt(0).toUpperCase() + s.case_type.slice(1)}{" "}
                  — {s.policyholder_name}:{" "}
                  {truncate(s.raw_text.replace(/\n/g, " "), 80)}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Custom text input */}
        {mode === "custom" && (
          <div className="space-y-3 mb-4">
            <div>
              <label
                htmlFor="custom-type"
                className="block text-sm font-medium text-slate-700 mb-1"
              >
                Tipo de siniestro
              </label>
              <select
                id="custom-type"
                value={customType}
                onChange={(e) => setCustomType(e.target.value as ClaimType)}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                {CLAIM_TYPES.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="custom-text"
                className="block text-sm font-medium text-slate-700 mb-1"
              >
                Texto del siniestro
              </label>
              <textarea
                id="custom-text"
                rows={5}
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="Pegá el texto del email de siniestro aquí..."
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="simulate-submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? t("simulate.submitting") : t("simulate.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
