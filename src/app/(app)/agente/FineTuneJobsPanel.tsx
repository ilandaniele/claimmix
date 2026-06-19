"use client";

import { useEffect, useState } from "react";

type FineTuneJob = {
  id: string;
  status: string;
  base_model: string;
  fine_tuned_model_id: string | null;
  openai_fine_tuning_job_id: string | null;
  training_example_count: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  activated_at: string | null;
  training_file_id: string | null;
  validation_file_id: string | null;
};

type ProviderId = "gemini" | "openai";
type SettingsResponse = {
  provider: ProviderId;
};

async function fetchJobs(): Promise<FineTuneJob[]> {
  const res = await fetch("/api/admin/fine-tuning/jobs", { cache: "no-store" });
  if (!res.ok) throw new Error("load_failed");
  const body = await res.json();
  return body.jobs ?? [];
}

async function fetchActiveProvider(): Promise<ProviderId> {
  const res = await fetch("/api/admin/ai-settings", { cache: "no-store" });
  if (!res.ok) throw new Error("settings_load_failed");
  const body = (await res.json()) as { data?: SettingsResponse } & SettingsResponse;
  return (body.data ?? body).provider;
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? body?.message ?? fallback;
}

export function FineTuneJobsPanel() {
  const [jobs, setJobs] = useState<FineTuneJob[]>([]);
  const [activeProvider, setActiveProvider] = useState<ProviderId>("gemini");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function reload() {
    const [nextJobs, nextProvider] = await Promise.all([
      fetchJobs(),
      fetchActiveProvider(),
    ]);
    setJobs(nextJobs);
    setActiveProvider(nextProvider);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchJobs(), fetchActiveProvider()])
      .then(([data, provider]) => {
        if (!cancelled) {
          setJobs(data);
          setActiveProvider(provider);
        }
      })
      .catch(() => {
        if (!cancelled) setError("No se pudo cargar fine-tuning.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openAiSelected = activeProvider === "openai";

  async function createDraft() {
    if (!openAiSelected) {
      setError("Fine-tuning esta disponible solo cuando OpenAI es el proveedor activo.");
      return;
    }
    setBusy("draft");
    setError("");
    try {
      const res = await fetch("/api/admin/fine-tuning/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "draft" }),
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, "No se pudo crear el trabajo."));
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el trabajo.");
    } finally {
      setBusy(null);
    }
  }

  async function rollback() {
    if (!openAiSelected) {
      setError("Rollback de fine-tuning esta disponible solo con OpenAI activo.");
      return;
    }
    setBusy("rollback");
    setError("");
    try {
      const res = await fetch("/api/admin/fine-tuning/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rollback" }),
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, "No se pudo hacer rollback."));
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo hacer rollback.");
    } finally {
      setBusy(null);
    }
  }

  async function action(job: FineTuneJob, actionName: "start" | "sync" | "approve" | "activate") {
    if (!openAiSelected) {
      setError("Fine-tuning esta disponible solo cuando OpenAI es el proveedor activo.");
      return;
    }
    setBusy(`${job.id}:${actionName}`);
    setError("");
    try {
      const res = await fetch(`/api/admin/fine-tuning/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionName }),
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, "No se pudo actualizar el trabajo."));
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el trabajo.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p className="text-sm text-slate-500">Cargando...</p>;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
          OpenAI fine-tuning opcional
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Gemini usa ejemplos aprobados como contexto inmediato. Esta seccion solo prepara y activa fine-tuning de OpenAI.
        </p>
      </div>

      {!openAiSelected && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Proveedor activo: Gemini. Cambia a OpenAI para usar fine-tuning opcional.
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={createDraft}
          disabled={busy !== null || !openAiSelected}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          Crear trabajo
        </button>
        <button
          type="button"
          onClick={rollback}
          disabled={busy !== null || !openAiSelected}
          className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
        >
          Rollback
        </button>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Para crear un trabajo primero necesitas ejemplos aprobados. Este panel arma el JSONL
        y permite iniciar fine-tuning solo cuando OpenAI es el proveedor activo.
      </p>

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-200">
          {error}
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300">
          <p className="font-medium text-slate-800 dark:text-slate-100">
            No hay trabajos de OpenAI fine-tuning.
          </p>
          <p className="mt-1">
            Los ejemplos aprobados ya estan disponibles como contexto del agente. Crear trabajo genera un borrador avanzado para OpenAI.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
          {jobs.map((job) => (
            <li key={job.id} className="px-4 py-3 dark:bg-slate-950/20">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{job.id.slice(0, 8)}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      {job.status}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{job.training_example_count} ejemplos</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-mono">{job.base_model}</span>
                    {job.fine_tuned_model_id && (
                      <span className="ml-2 font-mono">{job.fine_tuned_model_id}</span>
                    )}
                  </div>
                  {job.error_message && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-300">{job.error_message}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => action(job, "start")}
                    disabled={busy !== null || !openAiSelected || !["draft", "failed"].includes(job.status)}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    Iniciar
                  </button>
                  <button
                    type="button"
                    onClick={() => action(job, "sync")}
                    disabled={busy !== null || !openAiSelected || !job.openai_fine_tuning_job_id}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    Sincronizar
                  </button>
                  <button
                    type="button"
                    onClick={() => action(job, "approve")}
                    disabled={busy !== null || !openAiSelected || job.status !== "eval_pending" || !job.fine_tuned_model_id}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    Aprobar eval
                  </button>
                  <button
                    type="button"
                    onClick={() => action(job, "activate")}
                    disabled={busy !== null || !openAiSelected || job.status !== "approved" || !job.fine_tuned_model_id}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    Activar
                  </button>
                  {job.training_file_id && (
                    <a
                      href={`/api/admin/fine-tuning/jobs/${job.id}/export?kind=train`}
                      className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-200"
                    >
                      JSONL
                    </a>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
