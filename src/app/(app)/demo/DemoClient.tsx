"use client";

import { useState } from "react";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";

// ── Presentational helpers ────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  full_name: "Nombre",
  email: "Email",
  phone: "Teléfono",
  dni: "DNI",
  policy_number: "Póliza",
  accident_date: "Fecha siniestro",
  accident_location: "Lugar",
  accident_description: "Descripción",
  claim_type: "Tipo",
};

const FRAUD_LABELS: Record<string, string> = {
  timeline_inconsistency: "Inconsistencia temporal",
  location_inconsistency: "Inconsistencia de lugar",
  damage_inconsistency: "Daño inconsistente",
  documentation_gap: "Documentación incompleta",
  repeat_claimant: "Reclamante recurrente",
  behavior_signal: "Señal de comportamiento",
  other: "Otro",
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function ConfidenceBar({ value }: { value: number }) {
  const p = Math.round(value * 100);
  const color =
    p >= 85 ? "bg-green-500" : p >= 60 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${p}%` }} />
      </div>
      <span className="w-10 text-right text-sm font-semibold text-slate-700">{p}%</span>
    </div>
  );
}

function InjurySeverityBadge({ level }: { level: string | null }) {
  if (!level || level === "none") return null;
  const map: Record<string, { label: string; cls: string }> = {
    fatal: { label: "Fatal", cls: "bg-red-100 text-red-700" },
    severe: { label: "Grave", cls: "bg-orange-100 text-orange-700" },
    minor: { label: "Leve", cls: "bg-amber-100 text-amber-700" },
  };
  const m = map[level];
  if (!m) return null;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

function FraudBadge({ level }: { level: string }) {
  if (level === "none") return null;
  const map: Record<string, { label: string; cls: string }> = {
    low: { label: "Riesgo bajo", cls: "bg-yellow-100 text-yellow-700" },
    medium: { label: "Riesgo medio", cls: "bg-amber-100 text-amber-700" },
    high: { label: "Riesgo alto", cls: "bg-red-100 text-red-700" },
  };
  const m = map[level];
  if (!m) return null;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${m.cls}`}>
      {m.label}
    </span>
  );
}

// ── Example email for the demo ────────────────────────────────────────────────

const EXAMPLE_SUBJECT =
  "Reporte de siniestro - Choque - Póliza 4821-A";

const EXAMPLE_BODY = `Buenos días,

Me comunico para reportar un siniestro ocurrido el día 24 de junio de 2026 en la intersección de Av. Rivadavia y Av. Carabobo, CABA.

Mi nombre es Roberto Fernández, DNI 28.543.221, titular de la póliza N° 4821-A.

El incidente fue un choque múltiple: el vehículo que iba delante frenó bruscamente y mi auto lo impactó por detrás. No hubo heridos, pero el vehículo sufrió daños en el paragolpes delantero y capot.

Adjunto fotos del accidente y constancia policial.

Quedo a disposición. Teléfono de contacto: +54 11 4523-8812.

Saludos,
Roberto Fernández`;

// ── Result section ────────────────────────────────────────────────────────────

function ResultSection({ result }: { result: ExtractedClaim }) {
  const isClaim = result.is_claim;
  const confidence = result.confidence;
  const fields = result.extracted_fields;
  const hasFraud = result.fraud_risk_level !== "none";
  const hasInjury = result.injury_severity && result.injury_severity !== "none";

  return (
    <div className="space-y-5">
      {/* ── Clasificación ───────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
          Clasificación
        </h3>
        <div className="flex items-center gap-3 mb-4">
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${
              isClaim
                ? "bg-green-100 text-green-700"
                : isClaim === false
                  ? "bg-slate-100 text-slate-500"
                  : "bg-yellow-100 text-yellow-700"
            }`}
          >
            {isClaim === true
              ? "✓ Es un siniestro"
              : isClaim === false
                ? "No es un siniestro"
                : "No determinado"}
          </span>
          {hasInjury && <InjurySeverityBadge level={result.injury_severity} />}
          {hasFraud && <FraudBadge level={result.fraud_risk_level} />}
        </div>

        <div className="mb-1 text-xs text-slate-500">Confianza del clasificador</div>
        <ConfidenceBar value={confidence} />

        {result.summary && (
          <p className="mt-4 text-sm text-slate-600 leading-relaxed border-t border-slate-100 pt-4">
            {result.summary}
          </p>
        )}
      </div>

      {/* ── Campos extraídos ─────────────────────────────────────────────────── */}
      {fields && Object.keys(fields).length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Datos extraídos
          </h3>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Object.entries(fields).map(([key, val]) => {
              if (!val) return null;
              const fc = result.field_confidences?.[key] ?? null;
              return (
                <div key={key} className="rounded-md bg-slate-50 px-3 py-2">
                  <dt className="text-xs text-slate-400">
                    {FIELD_LABELS[key] ?? key}
                  </dt>
                  <dd className="mt-0.5 text-sm font-medium text-slate-800">
                    {val}
                    {fc !== null && (
                      <span className="ml-2 text-xs text-slate-400">{pct(fc)}</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          {result.missing_fields && result.missing_fields.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              <span className="text-xs text-slate-400">Falta:</span>
              {result.missing_fields.map((f) => (
                <span
                  key={f}
                  className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
                >
                  {FIELD_LABELS[f] ?? f}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Alertas de fraude ────────────────────────────────────────────────── */}
      {hasFraud && (
        <div
          className={`rounded-lg border p-5 ${
            result.fraud_risk_level === "high"
              ? "border-red-200 bg-red-50"
              : result.fraud_risk_level === "medium"
                ? "border-amber-200 bg-amber-50"
                : "border-yellow-200 bg-yellow-50"
          }`}
        >
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              Señales de fraude
            </h3>
            <FraudBadge level={result.fraud_risk_level} />
          </div>
          {result.fraud_indicators && result.fraud_indicators.length > 0 ? (
            <ul className="space-y-2">
              {result.fraud_indicators.map((ind, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span
                    className={`mt-0.5 rounded px-1.5 py-0.5 text-xs font-medium shrink-0 ${
                      result.fraud_risk_level === "high"
                        ? "bg-red-100 text-red-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {FRAUD_LABELS[ind.type] ?? ind.type}
                  </span>
                  <span className="text-slate-700">{ind.description}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-3 text-xs text-slate-500">
            Solo orientativo — requiere validación del analista.
          </p>
        </div>
      )}

      {/* ── Modelo ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>Modelo: {result.extraction_model}</span>
        <span>
          {result.prompt_tokens + result.completion_tokens > 0
            ? `${result.prompt_tokens + result.completion_tokens} tokens`
            : ""}
        </span>
      </div>
    </div>
  );
}

// ── Main client component ─────────────────────────────────────────────────────

type Stage = "idle" | "loading" | "done" | "error";

export function DemoClient() {
  const [subject, setSubject] = useState(EXAMPLE_SUBJECT);
  const [body, setBody] = useState(EXAMPLE_BODY);
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<ExtractedClaim | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleAnalyze() {
    if (!subject.trim() || !body.trim()) return;
    setStage("loading");
    setResult(null);
    setErrorMsg(null);

    try {
      const res = await fetch("/api/demo/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      });

      const data = await res.json() as { error?: { message?: string } } & ExtractedClaim;

      if (!res.ok) {
        setErrorMsg(data.error?.message ?? `Error ${res.status}`);
        setStage("error");
        return;
      }

      setResult(data);
      setStage("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Error de red.");
      setStage("error");
    }
  }

  function handleReset() {
    setStage("idle");
    setResult(null);
    setErrorMsg(null);
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* ── Left: input form ──────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div>
          <label htmlFor="demo-subject" className="mb-1.5 block text-sm font-medium text-slate-700">
            Asunto del email
          </label>
          <input
            id="demo-subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="Asunto del email..."
            disabled={stage === "loading"}
          />
        </div>

        <div>
          <label htmlFor="demo-body" className="mb-1.5 block text-sm font-medium text-slate-700">
            Cuerpo del email
          </label>
          <textarea
            id="demo-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={16}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none font-mono"
            placeholder="Pegá el email del asegurado aquí..."
            disabled={stage === "loading"}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleAnalyze}
            disabled={stage === "loading" || !subject.trim() || !body.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            {stage === "loading" ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Analizando...
              </>
            ) : (
              "Analizar con Gemini"
            )}
          </button>

          {(stage === "done" || stage === "error") && (
            <button
              onClick={handleReset}
              className="text-sm text-slate-500 hover:text-slate-700 underline"
            >
              Limpiar
            </button>
          )}
        </div>
      </div>

      {/* ── Right: results ──────────────────────────────────────────────────── */}
      <div>
        {stage === "idle" && (
          <div className="flex h-full min-h-64 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50">
            <p className="text-sm text-slate-400">
              Los resultados del análisis aparecerán aquí.
            </p>
          </div>
        )}

        {stage === "loading" && (
          <div className="flex h-full min-h-64 items-center justify-center rounded-lg border border-slate-200 bg-white">
            <div className="text-center">
              <svg
                className="mx-auto h-8 w-8 animate-spin text-indigo-500"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              <p className="mt-3 text-sm font-medium text-slate-600">Procesando con Gemini...</p>
              <p className="mt-1 text-xs text-slate-400">Extrayendo campos del siniestro</p>
            </div>
          </div>
        )}

        {stage === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-5">
            <p className="text-sm font-medium text-red-700">Error al analizar</p>
            <p className="mt-1 text-sm text-red-600">{errorMsg}</p>
          </div>
        )}

        {stage === "done" && result && <ResultSection result={result} />}
      </div>
    </div>
  );
}
