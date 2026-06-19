"use client";

import { useState } from "react";
import { Download } from "lucide-react";

type ExportType = "config_only" | "memory_only" | "full";
type PiiMode = "masked" | "excluded" | "full_admin_only";
type ExportFormat = "json" | "jsonl" | "csv";

const EXPORT_TYPES: Array<{ value: ExportType; label: string }> = [
  { value: "config_only", label: "config_only" },
  { value: "memory_only", label: "memory_only" },
  { value: "full", label: "full" },
];

const PII_MODES: Array<{ value: PiiMode; label: string }> = [
  { value: "masked", label: "masked" },
  { value: "excluded", label: "excluded" },
  { value: "full_admin_only", label: "full_admin_only" },
];

const FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: "json", label: "json" },
  { value: "jsonl", label: "jsonl_approved_examples" },
  { value: "csv", label: "csv_summary" },
];

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match?.[1] ?? fallback;
}

export function AgentExportPanel({ role }: { role: string }) {
  const [exportType, setExportType] = useState<ExportType>("full");
  const [piiMode, setPiiMode] = useState<PiiMode>("masked");
  const [format, setFormat] = useState<ExportFormat>("json");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const canExportFull = role === "owner" || role === "admin";

  async function handleExport() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const params = new URLSearchParams({
        type: exportType,
        pii_mode: piiMode,
        format,
      });
      const res = await fetch(`/api/agent/export?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? "export_failed");
      }

      const blob = await res.blob();
      const fallback = `claimmix-agent-${exportType}.${format === "json" ? "json" : format}`;
      const filename = filenameFromDisposition(res.headers.get("content-disposition"), fallback);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      setMessage("Export listo.");
    } catch (err) {
      setError(err instanceof Error && err.message !== "export_failed" ? err.message : "No se pudo exportar.");
    } finally {
      setBusy(false);
    }
  }

  if (!canExportFull) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/70">
      <div className="grid gap-3 lg:grid-cols-[minmax(160px,1fr)_minmax(160px,1fr)_minmax(210px,1fr)_auto]">
        <label className="space-y-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          Export type
          <select
            value={exportType}
            onChange={(event) => setExportType(event.target.value as ExportType)}
            className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-900 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-100"
          >
            {EXPORT_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          PII mode
          <select
            value={piiMode}
            onChange={(event) => setPiiMode(event.target.value as PiiMode)}
            className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-900 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-100"
          >
            {PII_MODES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          Format
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
            className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-900 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-100"
          >
            {FORMATS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={handleExport}
          disabled={busy}
          className="inline-flex min-h-10 items-center justify-center gap-2 self-end rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
        >
          <Download size={16} />
          {busy ? "Exporting..." : "Export Agent Memory & Config"}
        </button>
      </div>

      {message && (
        <p role="status" className="mt-3 text-xs text-green-600 dark:text-green-300">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
