"use client";

/**
 * AgentRunPanel — live agent extraction preview for the case detail page.
 *
 * Fixes "preview values not loading": fetches /api/cases/:id/agent-run with
 * cache:'no-store' keyed by caseId (never stale data from another email) and
 * polls every 5s while the case is still being processed, so values appear
 * as soon as extraction lands without a manual reload.
 *
 * Shows: extracted values with confidence bars, missing fields, fields
 * pending confirmation, original email text, raw extracted JSON, the
 * trainability suggestion, plus:
 *   - "Confirmar como ejemplo de entrenamiento seguro" (role-gated; the ONLY
 *     way the agent learns from an email)
 *   - "Descargar JSON extraído" (claim-extraction-{caseId}-{messageId}.json)
 */

import { useEffect, useRef, useState } from "react";
import { anchoDeBarra } from "@/lib/ui/ancho-de-barra";

// ── Types (mirror /api/cases/:id/agent-run response) ──────────────────────────

interface RunField {
  field_key: string;
  field_value: string;
  confidence: number;
  source?: string;
}

interface AgentRun {
  id: string;
  model_provider: string;
  model_name: string;
  prompt_version: string;
  input_payload: { subject?: string; body?: string; sender_email?: string | null };
  output_payload: {
    fields?: RunField[];
    missing_fields?: string[];
    fields_pending_confirmation?: string[];
    summary?: string;
    is_claim?: boolean | null;
    severity?: string | null;
  } & Record<string, unknown>;
  missing_fields: string[];
  is_trainable_suggestion: boolean;
  trainability_score: number;
  trainability_reasons: string[];
  blocking_reasons: string[];
  created_at: string;
}

interface AgentRunResponse {
  case_status: string;
  is_claim: boolean | null;
  run: AgentRun | null;
  extracted_fields: Array<{
    field_key: string;
    field_value: string;
    confidence: number | null;
  }>;
  missing_docs: Array<{ doc_key: string }>;
  pending_confirmations: Array<{
    field_key: string;
    proposed_value: string | null;
    confidence: number;
  }>;
  already_approved: boolean;
}

type LoadState = "loading" | "ready" | "error";

const PROCESSING_STATUSES = new Set(["recibido", "procesando"]);
const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 24; // ~2 minutes

const BLOCKING_LABELS: Record<string, string> = {
  invalid_json: "JSON inválido",
  not_a_claim: "No es un reclamo",
  no_linked_case: "Sin caso vinculado",
  prompt_injection_suspected: "Posible inyección de prompt",
  unresolved_conflicts: "Conflictos sin resolver",
};

// ── Small confidence bar ──────────────────────────────────────────────────────

function ConfidenceMiniBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.7 ? "bg-green-500" : value >= 0.5 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
        <div className={`h-full ${color} ${anchoDeBarra(pct)}`} />
      </div>
      <span className="text-xs tabular-nums text-slate-500">{pct}%</span>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface AgentRunPanelProps {
  caseId: string;
  /** True when the current user may confirm training examples (owner/admin/specialist). */
  canConfirmTraining: boolean;
}

export function AgentRunPanel({ caseId, canConfirmTraining }: AgentRunPanelProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [data, setData] = useState<AgentRunResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const pollCount = useRef(0);

  // Reset during render when the selected case changes — no stale values from
  // a previously viewed email (React's "adjust state when props change" pattern).
  const [loadedCaseId, setLoadedCaseId] = useState(caseId);
  if (loadedCaseId !== caseId) {
    setLoadedCaseId(caseId);
    setLoadState("loading");
    setData(null);
    setConfirmMsg(null);
  }

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    pollCount.current = 0;

    async function load() {
      try {
        const res = await fetch(`/api/cases/${caseId}/agent-run`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("fetch_failed");
        const body = (await res.json()) as AgentRunResponse;
        if (cancelled) return;
        setData(body);
        setLoadState("ready");

        // Keep polling while extraction is in flight and no run exists yet.
        const stillProcessing =
          PROCESSING_STATUSES.has(body.case_status) || (!body.run && pollCount.current < 3);
        if (stillProcessing && pollCount.current < MAX_POLLS) {
          pollCount.current += 1;
          timer = setTimeout(load, POLL_INTERVAL_MS);
        }
      } catch {
        if (!cancelled) setLoadState("error");
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [caseId]);

  async function handleConfirmTraining() {
    if (!data?.run) return;
    setConfirming(true);
    setConfirmMsg(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/confirm-training`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_run_id: data.run.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setConfirmMsg({
          kind: "error",
          text: body?.error?.message ?? "No se pudo confirmar el ejemplo.",
        });
        return;
      }
      setData((prev) => (prev ? { ...prev, already_approved: true } : prev));
      setConfirmMsg({
        kind: "ok",
        text: "Ejemplo confirmado. El agente lo usará como contexto aprobado en próximos análisis.",
      });
    } catch {
      setConfirmMsg({ kind: "error", text: "No se pudo confirmar el ejemplo." });
    } finally {
      setConfirming(false);
    }
  }

  // ── Loading state ────────────────────────────────────────────────────────────
  if (loadState === "loading") {
    return (
      <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Cargando análisis del agente">
        <div className="h-4 w-40 rounded bg-slate-200" />
        <div className="h-3 w-full rounded bg-slate-100" />
        <div className="h-3 w-4/5 rounded bg-slate-100" />
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────────
  if (loadState === "error" || !data) {
    return (
      <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
        No se pudo cargar el análisis del agente. Recargá la página para reintentar.
      </div>
    );
  }

  const { run } = data;

  // ── Empty state (no run yet) ─────────────────────────────────────────────────
  if (!run) {
    const processing = PROCESSING_STATUSES.has(data.case_status);
    return (
      <p className="text-sm text-slate-400">
        {processing
          ? "El agente está procesando este email… los valores extraídos aparecerán acá automáticamente."
          : "Todavía no hay un análisis del agente registrado para este caso. Usá «Re-analizar» para generarlo."}
      </p>
    );
  }

  const persistedFields = data.extracted_fields
    .filter((f) => f.field_value && f.field_value.trim() !== "")
    .map((f) => ({
      field_key: f.field_key,
      field_value: f.field_value,
      confidence: f.confidence ?? 0,
      source: "persisted",
    }));
  const rawRunFields = (run.output_payload.fields ?? []).filter(
    (f) => f.field_value && f.field_value.trim() !== ""
  );
  const runFields = persistedFields.length > 0 ? persistedFields : rawRunFields;
  const pendingKeys =
    data.pending_confirmations.length > 0
      ? data.pending_confirmations.map((c) => c.field_key)
      : (run.output_payload.fields_pending_confirmation ?? []);
  const missingKeys =
    data.missing_docs.length > 0
      ? data.missing_docs.map((d) => d.doc_key)
      : run.missing_fields;
  const scorePct = Math.round(run.trainability_score * 100);

  return (
    <div className="space-y-5" data-testid="agent-run-panel">
      {/* ── Run metadata ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="font-mono">{run.model_name}</span>
        <span aria-hidden="true">·</span>
        <span className="font-mono">{run.prompt_version}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={run.created_at}>
          {new Date(run.created_at).toLocaleString("es-AR")}
        </time>
      </div>

      {/* ── Trainability suggestion ──────────────────────────────────────────── */}
      <div className="rounded-lg border border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                run.is_trainable_suggestion
                  ? "bg-green-100 text-green-800"
                  : "bg-slate-100 text-slate-600"
              }`}
            >
              {run.is_trainable_suggestion
                ? "Sugerido para entrenamiento"
                : "No sugerido para entrenamiento"}
            </span>
            <span className="text-xs tabular-nums text-slate-500">
              Puntaje: {scorePct}%
            </span>
          </div>

          <div className="flex items-center gap-2">
            <a
              href={`/api/cases/${caseId}/extraction.json`}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Descargar JSON extraído
            </a>
            {canConfirmTraining && (
              <button
                type="button"
                onClick={handleConfirmTraining}
                disabled={confirming || data.already_approved}
                className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {data.already_approved
                  ? "Ejemplo ya confirmado"
                  : confirming
                    ? "Confirmando…"
                    : "Confirmar como ejemplo de entrenamiento seguro"}
              </button>
            )}
          </div>
        </div>

        {run.blocking_reasons.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {run.blocking_reasons.map((reason) => (
              <span
                key={reason}
                className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
              >
                {BLOCKING_LABELS[reason] ?? reason}
              </span>
            ))}
          </div>
        )}

        {confirmMsg && (
          <div
            role={confirmMsg.kind === "error" ? "alert" : "status"}
            className={`mt-2 rounded-md px-3 py-2 text-xs ${
              confirmMsg.kind === "error"
                ? "bg-red-50 text-red-700"
                : "bg-green-50 text-green-700"
            }`}
          >
            {confirmMsg.text}
          </div>
        )}

        <p className="mt-2 text-xs text-slate-400">
          El agente nunca aprende de un email automáticamente: solo después de
          esta confirmación humana se usa como ejemplo aprobado.
        </p>
      </div>

      {/* ── Extracted values + confidence bars ───────────────────────────────── */}
      {runFields.length > 0 ? (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Valores extraídos (último análisis)
          </h3>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {runFields.map((field) => (
              <li
                key={field.field_key}
                className="flex items-center justify-between gap-3 px-4 py-2"
              >
                <div className="min-w-0">
                  <span className="block text-xs font-medium text-slate-500">
                    {field.field_key}
                  </span>
                  <span className="block truncate text-sm text-slate-800">
                    {field.field_value}
                  </span>
                </div>
                <ConfidenceMiniBar value={field.confidence} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-slate-400">
          El agente no extrajo valores en el último análisis.
        </p>
      )}

      {/* ── Pending confirmation + missing fields ────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Pendientes de confirmación
          </h3>
          {pendingKeys.length === 0 ? (
            <p className="text-xs text-slate-400">Sin campos pendientes.</p>
          ) : (
            <ul className="space-y-1">
              {pendingKeys.map((key) => (
                <li
                  key={key}
                  className="inline-flex mr-1.5 items-center rounded-full bg-yellow-50 px-2 py-0.5 text-xs text-yellow-800"
                >
                  {key}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Campos faltantes
          </h3>
          {missingKeys.length === 0 ? (
            <p className="text-xs text-slate-400">Sin campos faltantes.</p>
          ) : (
            <ul className="space-y-1">
              {missingKeys.map((key) => (
                <li
                  key={key}
                  className="inline-flex mr-1.5 items-center rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700"
                >
                  {key}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── Original email ───────────────────────────────────────────────────── */}
      <details className="group rounded-lg border border-slate-200">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Email original analizado
          {run.input_payload.subject ? ` — ${run.input_payload.subject}` : ""}
        </summary>
        <pre className="max-h-80 overflow-auto border-t border-slate-100 px-4 pb-4 pt-2 font-mono text-xs leading-relaxed text-slate-600 whitespace-pre-wrap">
          {run.input_payload.body || "(sin cuerpo)"}
        </pre>
      </details>

      {/* ── Raw extracted JSON ───────────────────────────────────────────────── */}
      <details className="group rounded-lg border border-slate-200">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
          JSON extraído (crudo)
        </summary>
        <pre className="max-h-80 overflow-auto border-t border-slate-100 px-4 pb-4 pt-2 font-mono text-xs leading-relaxed text-slate-600">
          {JSON.stringify(run.output_payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}
