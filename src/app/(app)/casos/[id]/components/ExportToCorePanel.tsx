/**
 * ExportToCorePanel — client component that calls POST /api/cases/:id/export-to-core
 * and renders the returned JSON payload in a read-only code block.
 *
 * AC15: "Exportar al Core" button visible on "listo" cases.
 *   - POST /api/cases/:id/export-to-core
 *   - Shows structured JSON in a code block.
 *   - "Copiar al portapapeles" button.
 */

"use client";

import { useState } from "react";
import { t } from "@/lib/i18n";

interface ExportToCorePanelProps {
  caseId: string;
  onError: (msg: string) => void;
}

export function ExportToCorePanel({ caseId, onError }: ExportToCorePanelProps) {
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<unknown | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleExport() {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/export-to-core`, {
        method: "POST",
      });
      if (res.ok) {
        const json = await res.json();
        setPayload(json);
      } else {
        onError("Error al exportar al core. Intentá de nuevo.");
      }
    } catch {
      onError("Error al exportar al core. Intentá de nuevo.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available in some contexts
    }
  }

  if (payload) {
    return (
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
            Payload de exportación
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 border border-slate-300 hover:bg-slate-50 transition-colors"
            aria-label={t("case.detail.copyClipboard")}
          >
            {copied ? t("case.detail.copied") : t("case.detail.copyClipboard")}
          </button>
        </div>
        <pre
          className="rounded-lg bg-slate-900 text-green-300 text-xs p-4 overflow-auto max-h-80 leading-relaxed"
          aria-label="Payload de exportación al core"
        >
          {JSON.stringify(payload, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleExport}
      disabled={loading}
      className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      data-testid="export-core-button"
    >
      {loading ? "Exportando..." : t("case.detail.exportToCore")}
    </button>
  );
}
