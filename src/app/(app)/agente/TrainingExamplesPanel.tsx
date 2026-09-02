"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n/LocaleContext";
import type { TranslationKey } from "@/lib/i18n";

type TrainingExample = {
  id: string;
  case_id: string | null;
  claim_type: string | null;
  input_payload: { subject?: string; body?: string };
  status: string;
  approved_at: string | null;
  created_at: string;
};

/**
 * `status` es `text` en la base, no un enum, asi que un estado que no este aca
 * se muestra crudo: es preferible a dibujar un hueco.
 */
const ESTADO: Record<string, TranslationKey> = {
  approved: "ejemplos.estado.approved",
  rejected: "ejemplos.estado.rejected",
  pending: "ejemplos.estado.pending",
};

async function fetchExamples(): Promise<TrainingExample[]> {
  const res = await fetch("/api/admin/training-examples", { cache: "no-store" });
  if (!res.ok) throw new Error("load_failed");
  const body = await res.json();
  return body.examples ?? [];
}

export function TrainingExamplesPanel() {
  const [examples, setExamples] = useState<TrainingExample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const t = useT();

  async function reload() {
    setExamples(await fetchExamples());
  }

  useEffect(() => {
    let cancelled = false;
    fetchExamples()
      .then((data) => {
        if (!cancelled) setExamples(data);
      })
      .catch(() => {
        if (!cancelled) setError(t("ejemplos.errorCarga"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `t` cambia si cambia el idioma; el mensaje ya escrito no se retraduce
    // solo, y volver a pedir los ejemplos por eso seria peor que el problema.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setStatus(example: TrainingExample, status: "approved" | "rejected") {
    setError("");
    const res = await fetch(`/api/admin/training-examples/${example.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      setError(t("ejemplos.errorActualizar"));
      return;
    }
    await reload();
  }

  if (loading) return <p className="text-sm text-slate-500">{t("ejemplos.cargando")}</p>;

  return (
    <div className="space-y-3">
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
      {examples.length === 0 ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300">
          <p className="font-medium text-slate-800 dark:text-slate-100">
            {t("ejemplos.vacio.titulo")}
          </p>
          <p className="mt-1">
            {t("ejemplos.vacio.como")}
            <span className="font-medium"> {t("agente.confirmar")}</span>
            {t("ejemplos.vacio.paraQue")}
          </p>
          <a
            href="/bandeja?is_claim=true"
            className="mt-3 inline-flex rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-white dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {t("ejemplos.verCasos")}
          </a>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
          {examples.map((example) => (
            <li key={example.id} className="px-4 py-3 dark:bg-slate-950/20">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {example.input_payload?.subject || t("ejemplos.sinAsunto")}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {ESTADO[example.status] ? t(ESTADO[example.status]) : example.status}
                    </span>
                    {example.claim_type && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {example.claim_type}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                    {example.input_payload?.body || ""}
                  </p>
                </div>
                <div className="flex flex-shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => setStatus(example, "approved")}
                    disabled={example.status === "approved"}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    {t("ejemplos.aprobar")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatus(example, "rejected")}
                    disabled={example.status === "rejected"}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    {t("ejemplos.rechazar")}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
