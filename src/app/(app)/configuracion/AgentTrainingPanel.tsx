"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/LocaleContext";

type TrainingState = "idle" | "loading" | "saving" | "success" | "error";

export function AgentTrainingPanel() {
  const t = useT();
  const [content, setContent] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState<TrainingState>("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadTraining() {
      setState("loading");
      try {
        const res = await fetch("/api/admin/agent-training", { cache: "no-store" });
        if (!res.ok) throw new Error("load_failed");
        const body = await res.json();
        if (cancelled) return;
        setContent(body.training?.content ?? "");
        setEnabled(body.training?.enabled ?? true);
        setState("idle");
      } catch {
        if (!cancelled) {
          setErrorMsg(t("configuracion.agentTraining.loadError"));
          setState("error");
        }
      }
    }

    void loadTraining();
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg("");
    setState("saving");

    try {
      const res = await fetch("/api/admin/agent-training", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, enabled }),
      });
      if (!res.ok) throw new Error("save_failed");
      const body = await res.json();
      setContent(body.training?.content ?? content);
      setEnabled(body.training?.enabled ?? enabled);
      setState("success");
      setTimeout(() => setState("idle"), 2500);
    } catch {
      setErrorMsg(t("configuracion.agentTraining.saveError"));
      setState("error");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="agent_training" className="text-sm font-medium text-slate-700">
          {t("configuracion.agentTraining.label")}
        </label>
        <label className="inline-flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          {t("configuracion.agentTraining.enabled")}
        </label>
      </div>

      <textarea
        id="agent_training"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={state === "loading" || state === "saving"}
        className="min-h-64 w-full rounded-md border border-slate-200 px-3 py-3 font-mono text-sm leading-relaxed text-slate-900 focus:border-slate-400 focus:outline-none disabled:opacity-60"
        placeholder={t("configuracion.agentTraining.placeholder")}
        maxLength={20_000}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          {t("configuracion.agentTraining.helper")}
        </p>
        <button
          type="submit"
          disabled={state === "loading" || state === "saving"}
          className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {state === "saving" ? t("configuracion.agentTraining.saving") : t("configuracion.agentTraining.save")}
        </button>
      </div>

      {state === "success" && (
        <div role="status" className="rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">
          {t("configuracion.agentTraining.saved")}
        </div>
      )}

      {state === "error" && errorMsg && (
        <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {errorMsg}
        </div>
      )}
    </form>
  );
}
