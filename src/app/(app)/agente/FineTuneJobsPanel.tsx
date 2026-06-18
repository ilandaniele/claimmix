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

async function fetchJobs(): Promise<FineTuneJob[]> {
  const res = await fetch("/api/admin/fine-tuning/jobs", { cache: "no-store" });
  if (!res.ok) throw new Error("load_failed");
  const body = await res.json();
  return body.jobs ?? [];
}

export function FineTuneJobsPanel() {
  const [jobs, setJobs] = useState<FineTuneJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function reload() {
    setJobs(await fetchJobs());
  }

  useEffect(() => {
    let cancelled = false;
    fetchJobs()
      .then((data) => {
        if (!cancelled) setJobs(data);
      })
      .catch(() => {
        if (!cancelled) setError("No se pudieron cargar los trabajos.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function createDraft() {
    setBusy("draft");
    setError("");
    try {
      const res = await fetch("/api/admin/fine-tuning/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "draft" }),
      });
      if (!res.ok) throw new Error("draft_failed");
      await reload();
    } catch {
      setError("No se pudo crear el trabajo.");
    } finally {
      setBusy(null);
    }
  }

  async function rollback() {
    setBusy("rollback");
    setError("");
    try {
      const res = await fetch("/api/admin/fine-tuning/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rollback" }),
      });
      if (!res.ok) throw new Error("rollback_failed");
      await reload();
    } catch {
      setError("No se pudo hacer rollback.");
    } finally {
      setBusy(null);
    }
  }

  async function action(job: FineTuneJob, actionName: "start" | "sync" | "approve" | "activate") {
    setBusy(`${job.id}:${actionName}`);
    setError("");
    try {
      const res = await fetch(`/api/admin/fine-tuning/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionName }),
      });
      if (!res.ok) throw new Error("action_failed");
      await reload();
    } catch {
      setError("No se pudo actualizar el trabajo.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p className="text-sm text-slate-500">Cargando...</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={createDraft}
          disabled={busy !== null}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Crear trabajo
        </button>
        <button
          type="button"
          onClick={rollback}
          disabled={busy !== null}
          className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
        >
          Rollback
        </button>
      </div>

      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      {jobs.length === 0 ? (
        <p className="text-sm text-slate-400">Sin trabajos.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {jobs.map((job) => (
            <li key={job.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-500">{job.id.slice(0, 8)}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                      {job.status}
                    </span>
                    <span className="text-xs text-slate-500">{job.training_example_count} ejemplos</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    <span className="font-mono">{job.base_model}</span>
                    {job.fine_tuned_model_id && (
                      <span className="ml-2 font-mono">{job.fine_tuned_model_id}</span>
                    )}
                  </div>
                  {job.error_message && (
                    <p className="mt-1 text-xs text-red-600">{job.error_message}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => action(job, "start")}
                    disabled={busy !== null || !["draft", "failed"].includes(job.status)}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50"
                  >
                    Iniciar
                  </button>
                  <button
                    type="button"
                    onClick={() => action(job, "sync")}
                    disabled={busy !== null || !job.openai_fine_tuning_job_id}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50"
                  >
                    Sincronizar
                  </button>
                  <button
                    type="button"
                    onClick={() => action(job, "approve")}
                    disabled={busy !== null || job.status !== "eval_pending" || !job.fine_tuned_model_id}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50"
                  >
                    Aprobar eval
                  </button>
                  <button
                    type="button"
                    onClick={() => action(job, "activate")}
                    disabled={busy !== null || job.status !== "approved" || !job.fine_tuned_model_id}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50"
                  >
                    Activar
                  </button>
                  {job.training_file_id && (
                    <a
                      href={`/api/admin/fine-tuning/jobs/${job.id}/export?kind=train`}
                      className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700"
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
