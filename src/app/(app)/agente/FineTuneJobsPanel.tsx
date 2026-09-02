"use client";

import { useEffect, useState } from "react";

import { useLocale, useT } from "@/lib/i18n/LocaleContext";
import { ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";

type FineTuneJob = {
  id: string;
  status: string;
  provider: ProviderId;
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

// ─── Vertex AI types ──────────────────────────────────────────────────────────

type VertexJob = {
  id: string;
  status: string;
  base_model: string;
  training_example_count: number;
  validation_example_count: number | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  activated_at: string | null;
  vertex_tuning_job_name: string | null;
  vertex_tuned_model_endpoint: string | null;
};

type VertexConfig = {
  enabled: boolean;
  project: string | null;
  location: string | null;
  base_model: string | null;
  bucket: string | null;
  min_examples: number;
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

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

// ─── Vertex AI cost helpers ───────────────────────────────────────────────────

function estimateVertexCost(exampleCount: number): number {
  // $0.008/1K tokens × 1000 tokens/example × 3 epochs
  return (exampleCount * 1000 * 3) / 1000 * 0.008;
}

function fmtUsd(amount: number): string {
  return amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`;
}

// ─── Vertex AI panel ──────────────────────────────────────────────────────────

function VertexAiSection() {
  const [jobs, setJobs] = useState<VertexJob[]>([]);
  const [config, setConfig] = useState<VertexConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmStart, setConfirmStart] = useState<string | null>(null);
  const { locale, t } = useLocale();

  async function reload() {
    const res = await fetch("/api/admin/fine-tuning/vertex", { cache: "no-store" });
    if (!res.ok) throw new Error("load_failed");
    const body = await res.json();
    setJobs(body.jobs ?? []);
    setConfig(body.config ?? null);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/fine-tuning/vertex", { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) {
          setJobs(body.jobs ?? []);
          setConfig(body.config ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) setError("No se pudo cargar Vertex AI.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function vtxPost(
    body: Record<string, unknown>,
    label: string,
    fallback: string
  ) {
    setBusy(label);
    setError("");
    try {
      const res = await fetch("/api/admin/fine-tuning/vertex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, fallback));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(null);
    }
  }

  async function vtxJobPost(
    jobId: string,
    actionName: "activate" | "rollback",
    fallback: string
  ) {
    setBusy(`${jobId}:${actionName}`);
    setError("");
    try {
      const res = await fetch(`/api/admin/fine-tuning/vertex/${jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionName }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, fallback));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p className="text-xs text-slate-500">{t("ft.vertex.cargando")}</p>;

  const enabled = config?.enabled ?? false;

  const startedJobs = jobs.filter((j) => !["draft"].includes(j.status));
  const totalEstimatedCost = startedJobs.reduce(
    (sum, j) => sum + estimateVertexCost(j.training_example_count),
    0
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {t("ft.vertex.titulo")}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("ft.vertex.requiere")}{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 dark:bg-slate-800">
            VERTEX_AI_TUNING_ENABLED=true
          </code>{" "}
          {t("ft.vertex.precio")}
        </p>
      </div>

      {!enabled && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t("ft.vertex.deshabilitado")}
        </div>
      )}

      {enabled && config && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950/30 dark:text-slate-300">
          <span className="font-medium">{t("ft.vertex.proyecto")}</span> {config.project ?? "—"}{" "}
          <span className="ml-3 font-medium">{t("ft.vertex.region")}</span> {config.location ?? "—"}{" "}
          <span className="ml-3 font-medium">{t("ft.vertex.modeloBase")}</span> {config.base_model ?? "—"}{" "}
          <span className="ml-3 font-medium">{t("ft.vertex.minEjemplos")}</span> {config.min_examples}
        </div>
      )}

      {/* ── Spend summary ── */}
      {startedJobs.length > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs dark:border-violet-900 dark:bg-violet-950/30">
          <span className="font-medium text-violet-800 dark:text-violet-200">
            {t("ft.vertex.gastoTotal")}
          </span>
          <span className="rounded-full bg-violet-100 px-2 py-0.5 font-mono font-semibold text-violet-800 dark:bg-violet-900/60 dark:text-violet-100">
            {fmtUsd(totalEstimatedCost)}
          </span>
          <span className="text-slate-500 dark:text-slate-400">
            {startedJobs.length === 1
              ? t("ft.vertex.trabajoUno")
              : t("ft.vertex.trabajosVarios").replace("{n}", String(startedJobs.length))}
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null || !enabled}
          onClick={() => vtxPost({ action: "draft" }, "draft", t("ft.vertex.errorBorrador"))}
          className="rounded-md bg-violet-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {t("ft.vertex.crearBorrador")}
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-200">
          {error}
        </div>
      )}

      {jobs.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("ft.vertex.sinTrabajos")}{" "}
          {enabled ? t("ft.vertex.creaBorrador") : t("ft.vertex.habilitaPrimero")}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
          {jobs.map((job) => {
            const isStartable = ["draft", "failed"].includes(job.status);
            const isSyncable = !!job.vertex_tuning_job_name;
            const isActivatable = job.status === "approved" && !!job.vertex_tuned_model_endpoint;
            const jobCost = estimateVertexCost(job.training_example_count);
            const isPendingConfirm = confirmStart === job.id;

            return (
              <li key={job.id} className="px-4 py-3 dark:bg-slate-950/20">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                        {job.id.slice(0, 8)}
                      </span>
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-950/60 dark:text-violet-200">
                        Vertex AI
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        {job.status}
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {job.training_example_count === 1
                          ? t("ft.ejemploUno")
                          : t("ft.ejemplosVarios").replace(
                              "{n}",
                              String(job.training_example_count)
                            )}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          jobCost > 5
                            ? "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-200"
                            : jobCost > 1
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-200"
                            : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200"
                        }`}
                      >
                        {fmtUsd(jobCost)} {t("ft.vertex.est")}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono">{job.base_model}</span>
                      {job.vertex_tuning_job_name && (
                        <span className="ml-2 font-mono text-slate-400 dark:text-slate-500">
                          {job.vertex_tuning_job_name.split("/").at(-1)}
                        </span>
                      )}
                    </div>
                    {job.vertex_tuned_model_endpoint && (
                      <p className="mt-0.5 font-mono text-xs text-emerald-600 dark:text-emerald-400">
                        {job.vertex_tuned_model_endpoint}
                      </p>
                    )}
                    {job.activated_at && (
                      <p className="mt-0.5 text-xs text-emerald-600 dark:text-emerald-400">
                        {/*
                          * Idioma de quien mira, zona del negocio. Sin
                          * argumentos tomaba las dos del navegador, y la fecha
                          * se comparaba despues contra el resto del producto,
                          * que esta fijado a Buenos Aires.
                          */}
                        {t("ft.vertex.activoDesde").replace(
                          "{f}",
                          new Date(job.activated_at).toLocaleDateString(locale, {
                            timeZone: ZONA_ARGENTINA,
                          })
                        )}
                      </p>
                    )}
                    {job.error_message && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-300">{job.error_message}</p>
                    )}

                    {/* ── Cost confirmation banner ── */}
                    {isPendingConfirm && (
                      <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-700 dark:bg-amber-950/40">
                        <span className="text-xs text-amber-800 dark:text-amber-200">
                          {t("ft.vertex.confirmarCosto")}{" "}
                          <strong>{fmtUsd(jobCost)}</strong>.
                        </span>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => {
                            setConfirmStart(null);
                            vtxPost(
                              { action: "start", jobId: job.id },
                              `${job.id}:start`,
                              t("ft.vertex.errorIniciar")
                            );
                          }}
                          className="shrink-0 rounded-md bg-amber-700 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                        >
                          {t("ft.vertex.confirmar")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmStart(null)}
                          className="shrink-0 rounded-md border border-amber-300 px-2.5 py-1 text-xs text-amber-700 dark:border-amber-700 dark:text-amber-300"
                        >
                          {t("ft.vertex.cancelar")}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy !== null || !enabled || !isStartable}
                      onClick={() => {
                        if (isPendingConfirm) return;
                        setConfirmStart(job.id);
                      }}
                      className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                    >
                      {t("ft.iniciar")}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null || !enabled || !isSyncable}
                      onClick={() =>
                        vtxPost(
                          { action: "sync", jobId: job.id },
                          `${job.id}:sync`,
                          t("ft.vertex.errorSincronizar")
                        )
                      }
                      className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                    >
                      {t("ft.sincronizar")}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null || !enabled || !isActivatable}
                      onClick={() =>
                        vtxJobPost(job.id, "activate", t("ft.vertex.errorActivar"))
                      }
                      className="rounded-md border border-emerald-300 px-2.5 py-1 text-xs text-emerald-700 disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-300"
                    >
                      {t("ft.vertex.activarModelo")}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null || !enabled}
                      onClick={() =>
                        vtxJobPost(job.id, "rollback", t("ft.errorRollback"))
                      }
                      className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                    >
                      {t("ft.rollback")}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function FineTuneJobsPanel() {
  const [jobs, setJobs] = useState<FineTuneJob[]>([]);
  const [activeProvider, setActiveProvider] = useState<ProviderId>("gemini");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const t = useT();

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
        if (!cancelled) setError(t("ft.errorCarga"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `t` cambia con el idioma; el mensaje ya escrito no se retraduce solo, y
    // volver a pedir los trabajos por eso seria peor que el problema.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAiSelected = activeProvider === "openai";

  async function createDraft() {
    setBusy("draft");
    setError("");
    try {
      const res = await fetch("/api/admin/fine-tuning/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "draft" }),
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, t("ft.errorCrear")));
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ft.errorCrear"));
    } finally {
      setBusy(null);
    }
  }

  async function rollback() {
    if (!openAiSelected) {
      setError(t("ft.rollbackSoloOpenai"));
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
        throw new Error(await readErrorMessage(res, t("ft.errorRollback")));
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ft.errorRollback"));
    } finally {
      setBusy(null);
    }
  }

  async function action(job: FineTuneJob, actionName: "start" | "sync" | "approve" | "activate") {
    if (job.provider === "openai" && !openAiSelected) {
      setError(t("ft.openaiSoloConOpenai"));
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
        throw new Error(await readErrorMessage(res, t("ft.errorActualizar")));
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ft.errorActualizar"));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p className="text-sm text-slate-500">{t("ft.cargando")}</p>;

  return (
    <div className="space-y-6">
      {/* ── Context-pack / OpenAI section ── */}
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
            {t("ft.titulo")}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t("ft.subtitulo")}
          </p>
        </div>

        {activeProvider === "gemini" && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            {t("ft.geminiActivo")}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={createDraft}
            disabled={busy !== null}
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {activeProvider === "gemini" ? t("ft.crearGemini") : t("ft.crearOpenai")}
          </button>
          <button
            type="button"
            onClick={rollback}
            disabled={busy !== null || !openAiSelected}
            className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
          >
            {t("ft.rollback")}
          </button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("ft.ayuda")}
        </p>

        {error && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-200">
            {error}
          </div>
        )}

        {jobs.length === 0 ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300">
            <p className="font-medium text-slate-800 dark:text-slate-100">
              {t("ft.sinPaquetes")}
            </p>
            <p className="mt-1">
              {t("ft.sinPaquetesDetalle")}
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
                      <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-200">
                        {job.provider === "gemini" ? t("ft.geminiContext") : t("ft.openaiFinetune")}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        {job.status}
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {job.training_example_count === 1
                          ? t("ft.ejemploUno")
                          : t("ft.ejemplosVarios").replace(
                              "{n}",
                              String(job.training_example_count)
                            )}
                      </span>
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
                    {job.provider === "gemini" ? (
                      <>
                        <button
                          type="button"
                          onClick={() => action(job, "start")}
                          disabled={busy !== null}
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                        >
                          {t("ft.actualizar")}
                        </button>
                        <button
                          type="button"
                          onClick={() => action(job, "activate")}
                          disabled={busy !== null || activeProvider === "gemini"}
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                        >
                          {t("ft.activarGemini")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => action(job, "start")}
                          disabled={busy !== null || !openAiSelected || !["draft", "failed"].includes(job.status)}
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                        >
                          {t("ft.iniciar")}
                        </button>
                        <button
                          type="button"
                          onClick={() => action(job, "sync")}
                          disabled={busy !== null || !openAiSelected || !job.openai_fine_tuning_job_id}
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                        >
                          {t("ft.sincronizar")}
                        </button>
                        <button
                          type="button"
                          onClick={() => action(job, "approve")}
                          disabled={busy !== null || !openAiSelected || job.status !== "eval_pending" || !job.fine_tuned_model_id}
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                        >
                          {t("ft.aprobarEval")}
                        </button>
                        <button
                          type="button"
                          onClick={() => action(job, "activate")}
                          disabled={busy !== null || !openAiSelected || job.status !== "approved" || !job.fine_tuned_model_id}
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                        >
                          {t("ft.activar")}
                        </button>
                      </>
                    )}
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

      {/* ── Divider ── */}
      <div className="border-t border-slate-200 dark:border-slate-700" />

      {/* ── Vertex AI section ── */}
      <VertexAiSection />
    </div>
  );
}
