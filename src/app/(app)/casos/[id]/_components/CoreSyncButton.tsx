/**
 * CoreSyncButton — Client Component for AC17.
 *
 * Shown only when cases.status = 'listo_para_core'.
 * Calls POST /api/cases/:id/sync-to-core.
 * Shows loading state, success (external ID), and error state.
 */

"use client";

import { useState } from "react";
import { t } from "@/lib/i18n";

interface CoreSyncButtonProps {
  caseId: string;
  /** Current status — only renders if 'listo_para_core' */
  currentStatus: string;
}

type SyncState =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "success"; externalId: string; sentAt: string }
  | { type: "error"; message: string };

export function CoreSyncButton({ caseId, currentStatus }: CoreSyncButtonProps) {
  const [syncState, setSyncState] = useState<SyncState>({ type: "idle" });

  // Only show when case is ready for core sync
  if (currentStatus !== "listo_para_core" && syncState.type === "idle") {
    return null;
  }

  const handleSync = async () => {
    setSyncState({ type: "loading" });
    try {
      const res = await fetch(`/api/cases/${caseId}/sync-to-core`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: false }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const msg =
          data?.error?.message ??
          t("case.detail.coreSyncError");
        setSyncState({ type: "error", message: msg });
        return;
      }

      if (data?.synced === true) {
        setSyncState({
          type: "success",
          externalId: data.externalId ?? "N/A",
          sentAt: new Date().toLocaleString("es-AR"),
        });
      } else {
        setSyncState({
          type: "error",
          message: data?.errorMessage ?? t("case.detail.coreSyncError"),
        });
      }
    } catch {
      setSyncState({
        type: "error",
        message: "Error de red. Intentá de nuevo.",
      });
    }
  };

  if (syncState.type === "success") {
    return (
      <div
        role="status"
        className="rounded-lg border border-green-200 bg-green-50 px-4 py-3"
      >
        <p className="text-sm font-medium text-green-800">
          {t("case.detail.coreSyncSuccess")}
        </p>
        <p className="text-xs text-green-600 mt-0.5">
          ID externo:{" "}
          <span className="font-mono">{syncState.externalId}</span>
          {" · "}{syncState.sentAt}
        </p>
      </div>
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
          onClick={() => setSyncState({ type: "idle" })}
          className="text-xs text-slate-500 hover:text-slate-700 underline"
        >
          Reintentar
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
