/**
 * CoreSyncButton — Client Component for AC17.
 *
 * Shown when cases.status = 'listo_para_core', or 'error_core' to retry (force).
 * Calls POST /api/cases/:id/sync-to-core.
 * Shows loading and error states. On success the refreshed page leaves
 * `listo_para_core` and shows the sent panel with the external ID instead.
 */

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import { textoDelMotivo } from "@/lib/i18n/motivo-de-core";

interface CoreSyncButtonProps {
  caseId: string;
  /** Current status — only renders if 'listo_para_core' or 'error_core' */
  currentStatus: string;
}

type SyncState =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "success" }
  | { type: "error"; message: string };

export function CoreSyncButton({ caseId, currentStatus }: CoreSyncButtonProps) {
  const t = useT();
  const router = useRouter();
  const [syncState, setSyncState] = useState<SyncState>({ type: "idle" });

  const reintento = currentStatus === "error_core";
  if (currentStatus !== "listo_para_core" && !reintento && syncState.type === "idle") {
    return null;
  }

  const handleSync = async () => {
    setSyncState({ type: "loading" });
    try {
      const res = await fetch(`/api/cases/${caseId}/sync-to-core`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: reintento }),
      });

      const data = await res.json().catch(() => null);
      // El estado del caso cambió (o no): la ficha lo vuelve a leer.
      router.refresh();

      if (!res.ok) {
        const msg =
          data?.error?.message ??
          t("case.detail.coreSyncError");
        setSyncState({ type: "error", message: msg });
        return;
      }

      setSyncState(
        data?.synced === true
          ? { type: "success" }
          : { type: "error", message: textoDelMotivo(t, data?.errorMessage) }
      );
    } catch {
      setSyncState({ type: "error", message: t("case.detail.coreSyncRed") });
    }
  };

  // Hasta que llega la ficha nueva: ahí este botón desaparece y el panel de enviado muestra el ID.
  if (syncState.type === "success") {
    return (
      <p role="status" className="text-sm font-medium text-green-800">
        {t("case.detail.coreSyncSuccess")}
      </p>
    );
  }

  if (syncState.type === "error") {
    return (
      <div className="space-y-2">
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3"
        >
          <p className="text-sm font-medium text-red-800">
            {t("case.detail.coreSyncError")}
          </p>
          <p className="text-xs text-red-600 mt-0.5">{syncState.message}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setSyncState({ type: "idle" });
            router.refresh();
          }}
          className="text-xs text-slate-500 hover:text-slate-700 underline"
        >
          {t("case.detail.coreSyncReintentarBoton")}
        </button>
      </div>
    );
  }

  const isLoading = syncState.type === "loading";

  return (
    <button
      type="button"
      disabled={isLoading}
      onClick={handleSync}
      className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      aria-label={t("case.detail.sendToCore")}
    >
      {isLoading ? (
        <>
          <svg
            className="animate-spin h-4 w-4"
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
              d="M4 12a8 8 0 018-8v8H4z"
            />
          </svg>
          {t("case.detail.sendingToCore")}
        </>
      ) : (
        t("case.detail.sendToCore")
      )}
    </button>
  );
}
