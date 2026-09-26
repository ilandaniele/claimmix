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
import type { TranslationKey } from "@/lib/i18n";
import type { CaseStatus } from "@/lib/schemas/cases";
import type { EstadoDeAcciones } from "@/server/cases/acciones";

interface CaseDetailClientProps {
  caseId: string;
  status: CaseStatus;
  caseNumber: string;
  paraResponder: boolean;
  /** Cuándo el servidor leyó el caso: lo que entró después, nadie lo vio. */
  vistoEn: string;
  /** Sin esto un viewer vería un botón que le contesta 403. */
  puedeMarcar: boolean;
  acciones: EstadoDeAcciones;
  puedeCambiarEstado: boolean;
}

type Aviso = [TranslationKey, "success" | "info"];

export function CaseDetailClient({
  caseId,
  status,
  caseNumber,
  paraResponder,
  vistoEn,
  puedeMarcar,
  acciones,
  puedeCambiarEstado,
}: CaseDetailClientProps) {
  const t = useT();
  const router = useRouter();
  const { toasts, addToast, dismissToast } = useToast();

  const [showClose, setShowClose] = useState(false);
  const [showEscalate, setShowEscalate] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [reAnalyzing, setReAnalyzing] = useState(false);
  const [marcando, setMarcando] = useState(false);

  const dialogOpen = showClose || showEscalate || transitioning;

  // Las acciones directas hacen lo mismo: pedir, avisar y refrescar. Cambian
  // la ruta, el aviso y qué error se reconoce.
  async function accion(
    setOcupado: (ocupado: boolean) => void,
    url: string,
    init: RequestInit,
    aviso: (res: Response) => Aviso | Promise<Aviso>,
    errores: Partial<Record<number, TranslationKey>> = {}
  ) {
    setOcupado(true);
    try {
      const res = await fetch(url, init);
      if (res.ok) {
        const [clave, tipo] = await aviso(res);
        addToast(t(clave), tipo);
        router.refresh();
      } else {
        addToast(t(errores[res.status] ?? "error.generic"), "error");
      }
    } catch {
      addToast(t("error.generic"), "error");
    } finally {
      setOcupado(false);
    }
  }

  const handleTransition = (toStatus: CaseStatus) =>
    accion(
      setTransitioning,
      `/api/cases/${caseId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: toStatus }),
      },
      () => ["case.detail.statusUpdated", "success"],
      { 409: "close.errorFsm" }
    );

  const confirmarListo = (cuerpo: Record<string, unknown>) =>
    accion(setTransitioning, `/api/cases/${caseId}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) },
      () => ["case.detail.confirmado", "success"], { 409: "close.errorFsm" });
  const handleConfirmarListo = () => confirmarListo({ confirmar_listo: true });
  const handleRevisadoListo = () => confirmarListo({ status: "listo_para_core", confirmar_listo: true });

  const handleReAnalyze = () =>
    accion(
      setReAnalyzing,
      `/api/cases/${caseId}/re-analyze`,
      { method: "POST" },
      () => ["case.detail.reAnalyzeStarted", "success"],
      { 429: "case.detail.reAnalyzeRateLimit" }
    );

  // Si entró algo después de `vistoEn`, el caso sigue marcado: se refresca para
  // que se vea lo nuevo.
  const handleMarcarRespondido = () =>
    accion(
      setMarcando,
      `/api/cases/${caseId}/respondido`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visto: vistoEn }),
      },
      async (res) =>
        (await res.json()).actualizado
          ? ["case.paraResponder.hecho", "success"]
          : ["case.paraResponder.cambio", "info"]
    );

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
        {paraResponder && (
          <div
            role="status"
            className="flex max-w-md flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 sm:items-end sm:text-right"
          >
            <p>{t("case.paraResponder.banner")}</p>
            {puedeMarcar && (
              <button
                type="button"
                onClick={handleMarcarRespondido}
                disabled={marcando}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                {t("case.paraResponder.marcar")}
              </button>
            )}
          </div>
        )}
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
          acciones={acciones}
          puedeCambiarEstado={puedeCambiarEstado}
          onConfirmarListo={handleConfirmarListo}
          onRevisadoListo={handleRevisadoListo}
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
