/**
 * CaseDetailClient — handles interactive actions on the case detail page.
 *
 * Responsibilities:
 *   - Renders FSM-aware StatusActions.
 *   - Opens/closes CloseConfirmDialog (with type-to-confirm logic).
 *   - Opens/closes EscalateDialog.
 *   - Shows toast notifications for action results.
 *   - Handles direct transitions (e.g. esperando → listo) without dialogs.
 *   - Redirects to /bandeja after close.
 *   - Refreshes the page after status transitions.
 *
 * AC15: All status transitions validated server-side via PATCH /api/cases/:id.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusActions } from "./components/StatusActions";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { EscalateDialog } from "./components/EscalateDialog";
import { ToastContainer, useToast } from "@/app/(app)/bandeja/components/Toast";
import { useT } from "@/lib/i18n/LocaleContext";
import type { CaseStatus } from "@/lib/schemas/cases";

interface CaseDetailClientProps {
  caseId: string;
  status: CaseStatus;
  caseNumber: string;
}

export function CaseDetailClient({
  caseId,
  status,
  caseNumber,
}: CaseDetailClientProps) {
  const t = useT();
  const router = useRouter();
  const { toasts, addToast, dismissToast } = useToast();

  const [showClose, setShowClose] = useState(false);
  const [showEscalate, setShowEscalate] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [reAnalyzing, setReAnalyzing] = useState(false);

  const dialogOpen = showClose || showEscalate || transitioning;

  // ── Direct transition (no confirmation dialog) ─────────────────────────────
  async function handleTransition(toStatus: CaseStatus) {
    setTransitioning(true);
    try {
      const res = await fetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: toStatus }),
      });

      if (res.ok) {
        addToast(
          `Estado actualizado correctamente.`,
          "success"
        );
        // Refresh server data
        router.refresh();
      } else if (res.status === 409) {
        addToast("Transición de estado no válida.", "error");
      } else {
        addToast(t("error.generic"), "error");
      }
    } catch {
      addToast(t("error.generic"), "error");
    } finally {
      setTransitioning(false);
    }
  }

  // ── Re-analyze — trigger AI re-extraction ────────────────────────────────
  async function handleReAnalyze() {
    setReAnalyzing(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/re-analyze`, {
        method: "POST",
      });
      if (res.ok) {
        addToast(t("case.detail.reAnalyzeStarted"), "success");
        router.refresh();
      } else if (res.status === 429) {
        addToast(t("case.detail.reAnalyzeRateLimit"), "error");
      } else {
        addToast(t("error.generic"), "error");
      }
    } catch {
      addToast(t("error.generic"), "error");
    } finally {
      setReAnalyzing(false);
    }
  }

  // ── Close success — show toast, redirect to /bandeja ──────────────────────
  function handleCloseSuccess() {
    setShowClose(false);
    addToast(t("close.success"), "success");
    // Small delay so toast is visible before redirect
    setTimeout(() => {
      router.push("/bandeja");
    }, 1000);
  }

  // ── Escalate success — refresh page ───────────────────────────────────────
  function handleEscalateSuccess() {
    setShowEscalate(false);
    addToast(t("escalate.success"), "success");
    router.refresh();
  }

  return (
    <>
      <div
        className="flex flex-col items-start sm:items-end gap-2"
        data-testid="case-status-actions"
        aria-label="Acciones del caso"
      >
        <StatusActions
          caseId={caseId}
          status={status}
          caseNumber={caseNumber}
          onClose={() => setShowClose(true)}
          onEscalate={() => setShowEscalate(true)}
          onTransition={handleTransition}
          onReAnalyze={handleReAnalyze}
          reAnalyzing={reAnalyzing}
          onError={(msg) => addToast(msg, "error")}
          dialogOpen={dialogOpen}
        />
      </div>

      {/* Close confirmation dialog */}
      {showClose && (
        <CloseConfirmDialog
          caseId={caseId}
          caseNumber={caseNumber}
          onClose={() => setShowClose(false)}
          onSuccess={handleCloseSuccess}
          onError={(msg) => {
            setShowClose(false);
            addToast(msg, "error");
          }}
        />
      )}

      {/* Escalate dialog */}
      {showEscalate && (
        <EscalateDialog
          caseId={caseId}
          onClose={() => setShowEscalate(false)}
          onSuccess={handleEscalateSuccess}
          onError={(msg) => {
            setShowEscalate(false);
            addToast(msg, "error");
          }}
        />
      )}

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
