"use client";

import { useState, useEffect } from "react";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";

// ── Example emails ────────────────────────────────────────────────────────────

const EXAMPLES = {
  choque: {
    label: "Choque",
    subject: "Reporte de siniestro - Choque - Póliza 4821-A",
    body: `Buenos días,

Me comunico para reportar un siniestro ocurrido el día 26/06/2026 a las 10:30hs en Av. Corrientes 1500, CABA.

Mi nombre es Roberto Pérez, DNI 32.456.789, titular de la póliza N° 4821-A. Patente del vehículo: AB123CD.

El incidente fue un choque: el vehículo que iba delante frenó bruscamente y lo impacté por detrás. No hubo heridos. El vehículo sufrió daños en el paragolpes delantero.

Teléfono de contacto: +54 11 4523-8812.

Saludos,
Roberto Pérez`,
  },
  robo: {
    label: "Robo",
    subject: "Denuncia de robo de vehículo - Póliza 7291-B",
    body: `Buenas tardes,

Les escribo para informar el robo de mi vehículo ocurrido anoche entre las 22hs y las 7hs de hoy 26/06/2026 en calle Lavalle 850, Rosario, Santa Fe.

Soy María González, DNI 25.333.100, titular de la póliza 7291-B. El vehículo es un Ford Focus, patente GH456IJ, color gris.

Ya realicé la denuncia policial (número de denuncia: 2024-88231). Adjunto copia.

Quedo a la espera de instrucciones. Teléfono: +54 341 455-2210.

Saludos cordiales,
María González`,
  },
  granizo: {
    label: "Granizo",
    subject: "Siniestro por granizo - Toyota Corolla - Póliza 3301-C",
    body: `Hola,

El día de ayer, 25 de junio de 2026, durante la tormenta de granizo que afectó la zona norte del Gran Buenos Aires, mi vehículo sufrió daños considerables.

Me llamo Carlos Rodríguez, DNI 18.900.445, póliza N° 3301-C. El auto es un Toyota Corolla 2022, patente LM789NO, guardado en la calle (sin cochera).

El techo, el capot y el techo presentan abolladuras por granizo. No hubo heridos. Adjunto fotos.

Teléfono: 011-15-4499-3321.

Gracias,
Carlos Rodríguez`,
  },
} as const;

type ExampleKey = keyof typeof EXAMPLES;

// ── Field labels ──────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  full_name: "Nombre",
  email: "Email",
  phone: "Teléfono",
  dni: "DNI",
  policy_number: "N° Póliza",
  accident_date: "Fecha",
  accident_time: "Hora",
  accident_location: "Lugar",
  accident_description: "Descripción",
  claim_type: "Tipo",
  plate_number: "Patente",
  injured: "Heridos",
  police_report: "Denuncia policial",
};

const CLAIM_TYPE_LABELS: Record<string, string> = {
  choque: "CHOQUE",
  robo: "ROBO",
  granizo: "GRANIZO",
  incendio: "INCENDIO",
  cristales: "CRISTALES",
  rc: "RC",
  robo_contenido: "ROBO DE CONTENIDO",
  accidente_personal: "ACCIDENTE PERSONAL",
};

// ── Small helpers ─────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function Spinner({ size = 5 }: { size?: number }) {
  return (
    <svg
      className={`h-${size} w-${size} animate-spin`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const p = Math.round(value * 100);
  const color = p >= 85 ? "bg-green-500" : p >= 60 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${p}%` }} />
      </div>
      <span className="w-8 text-right text-xs font-semibold text-slate-600">{p}%</span>
    </div>
  );
}

// ── Animated field card ───────────────────────────────────────────────────────

function FieldCard({
  label,
  value,
  confidence,
  index,
}: {
  label: string;
  value: string;
  confidence: number | null;
  index: number;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), index * 80);
    return () => clearTimeout(t);
  }, [index]);

  return (
    <div
      className={`rounded-lg border border-slate-200 bg-white px-4 py-3 transition-all duration-300 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      }`}
    >
      <div className="text-xs text-slate-400 mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-slate-800">{value}</div>
      {confidence !== null && (
        <div className="mt-1.5">
          <ConfidenceBar value={confidence} />
        </div>
      )}
    </div>
  );
}

// ── Missing fields chips ──────────────────────────────────────────────────────

function MissingFields({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="text-xs font-semibold text-amber-700 mb-2">
        Campos faltantes — se piden automáticamente al asegurado
      </div>
      <div className="flex flex-wrap gap-2">
        {fields.map((f) => (
          <span
            key={f}
            className="inline-flex items-center gap-1 rounded-full bg-white border border-amber-200 px-2.5 py-0.5 text-xs text-amber-700"
          >
            <span>⚠</span> {FIELD_LABELS[f] ?? f}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── FNOL flow diagram ─────────────────────────────────────────────────────────

function FNOLFlow() {
  const steps = [
    { icon: "📧", label: "Recibe" },
    { icon: "🤖", label: "Extrae" },
    { icon: "📋", label: "Clasifica" },
    { icon: "🔍", label: "Matchea póliza" },
    { icon: "📨", label: "Pide datos faltantes" },
    { icon: "👤", label: "Ajustador revisa" },
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 mt-8">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-4">
        Flujo FNOL — Cómo funciona
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
              <span className="text-lg leading-none">{step.icon}</span>
              <span className="text-sm font-medium text-slate-700">{step.label}</span>
            </div>
            {i < steps.length - 1 && (
              <span className="text-slate-300 text-lg">→</span>
            )}
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-slate-400">
        Todo el flujo ocurre automáticamente desde que llega el email hasta que el ajustador tiene el caso listo para revisar.
        Tiempo típico: 4-6 horas vs 2-3 días sin automatización.
      </p>
    </div>
  );
}

// ── Result panel ──────────────────────────────────────────────────────────────

function ResultPanel({ result, elapsed }: { result: ExtractedClaim; elapsed: number }) {
  const isClaim = result.is_claim;
  const fields = result.extracted_fields ?? {};
  const fieldEntries = Object.entries(fields).filter(([, v]) => Boolean(v));

  const claimTypeLabel = result.extracted_fields?.claim_type
    ? (CLAIM_TYPE_LABELS[result.extracted_fields.claim_type as string] ?? String(result.extracted_fields.claim_type).toUpperCase())
    : null;

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-2">
        {claimTypeLabel && (
          <span className="rounded-lg bg-indigo-100 px-3 py-1 text-sm font-bold text-indigo-800">
            Tipo: {claimTypeLabel}
          </span>
        )}
        {result.injury_severity && result.injury_severity !== "none" && (
          <span className="rounded-lg bg-orange-100 px-3 py-1 text-sm font-bold text-orange-700">
            Severidad:{" "}
            {{ fatal: "FATAL", severe: "GRAVE", minor: "LEVE" }[result.injury_severity] ?? result.injury_severity.toUpperCase()}
          </span>
        )}
        {!isClaim && (
          <span className="rounded-lg bg-slate-100 px-3 py-1 text-sm font-medium text-slate-600">
            No es siniestro
          </span>
        )}
        <span className="ml-auto text-xs text-slate-400">
          Procesado en {(elapsed / 1000).toFixed(1)}s · Confianza {Math.round(result.confidence * 100)}%
        </span>
      </div>

      <div className="h-px bg-slate-100" />

      {/* Animated fields grid */}
      {fieldEntries.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {fieldEntries.map(([key, val], i) => (
            <FieldCard
              key={key}
              label={FIELD_LABELS[key] ?? key}
              value={String(val)}
              confidence={result.field_confidences?.[key] ?? null}
              index={i}
            />
          ))}
        </div>
      )}

      {/* Missing fields */}
      <MissingFields fields={result.missing_fields ?? []} />

      {/* Fraud indicators */}
      {result.fraud_risk_level && result.fraud_risk_level !== "none" && (
        <div className={`rounded-lg border p-4 ${
          result.fraud_risk_level === "high"
            ? "border-red-200 bg-red-50"
            : "border-amber-200 bg-amber-50"
        }`}>
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-600 mb-2">
            Señales de fraude detectadas
          </div>
          {result.fraud_indicators?.map((ind, i) => (
            <div key={i} className="text-sm text-slate-700 mt-1">
              · {ind.description}
            </div>
          ))}
        </div>
      )}

      {/* Summary */}
      {result.summary && (
        <p className="text-sm text-slate-500 leading-relaxed border-t border-slate-100 pt-3">
          {result.summary}
        </p>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Stage = "idle" | "loading" | "done" | "error";

export function DemoPublic() {
  const [activeExample, setActiveExample] = useState<ExampleKey>("choque");
  const [subject, setSubject] = useState<string>(EXAMPLES.choque.subject);
  const [body, setBody] = useState<string>(EXAMPLES.choque.body);
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<ExtractedClaim | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  function loadExample(key: ExampleKey) {
    setActiveExample(key);
    setSubject(EXAMPLES[key].subject);
    setBody(EXAMPLES[key].body);
    setStage("idle");
    setResult(null);
    setErrorMsg(null);
  }

  async function handleAnalyze() {
    if (!subject.trim() || !body.trim()) return;
    setStage("loading");
    setResult(null);
    setErrorMsg(null);

    const start = Date.now();
    try {
      const res = await fetch("/api/demo/public-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      });

      const data = await res.json() as { error?: { message?: string } } & ExtractedClaim;
      setElapsed(Date.now() - start);

      if (!res.ok) {
        setErrorMsg(data.error?.message ?? `Error ${res.status}`);
        setStage("error");
        return;
      }

      setResult(data);
      setStage("done");
    } catch (e) {
      setElapsed(Date.now() - start);
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
    <div>
      {/* Example selector */}
      <div className="mb-5 flex items-center gap-2">
        <span className="text-sm text-slate-500 mr-1">Ejemplos:</span>
        {(Object.keys(EXAMPLES) as ExampleKey[]).map((key) => (
          <button
            key={key}
            onClick={() => loadExample(key)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              activeExample === key
                ? "bg-indigo-600 text-white"
                : "bg-white border border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {EXAMPLES[key].label}
          </button>
        ))}
        <span className="text-slate-300 mx-1">|</span>
        <span className="text-xs text-slate-400">o pegá tu propio email</span>
      </div>

      {/* Two-column grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: input */}
        <div className="space-y-4">
          <div>
            <label htmlFor="demo-subject" className="mb-1.5 block text-sm font-medium text-slate-700">
              Asunto
            </label>
            <input
              id="demo-subject"
              type="text"
              value={subject}
              onChange={(e) => { setSubject(e.target.value); setActiveExample("choque"); }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
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
              onChange={(e) => { setBody(e.target.value); setActiveExample("choque"); }}
              rows={14}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
              placeholder="Pegá el email del asegurado aquí..."
              disabled={stage === "loading"}
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleAnalyze}
              disabled={stage === "loading" || !subject.trim() || !body.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
            >
              {stage === "loading" ? (
                <>
                  <Spinner size={4} />
                  Analizando...
                </>
              ) : (
                "Analizar con IA"
              )}
            </button>

            {(stage === "done" || stage === "error") && (
              <button
                onClick={handleReset}
                className="text-sm text-slate-400 hover:text-slate-600 underline"
              >
                Limpiar
              </button>
            )}
          </div>
        </div>

        {/* Right: results */}
        <div>
          {stage === "idle" && (
            <div className="flex h-full min-h-72 items-center justify-center rounded-xl border-2 border-dashed border-slate-200 bg-white/60">
              <div className="text-center">
                <div className="text-3xl mb-3">🤖</div>
                <p className="text-sm font-medium text-slate-500">Seleccioná un ejemplo o pegá un email</p>
                <p className="text-xs text-slate-400 mt-1">y hacé clic en "Analizar con IA"</p>
              </div>
            </div>
          )}

          {stage === "loading" && (
            <div className="flex h-full min-h-72 items-center justify-center rounded-xl border border-slate-200 bg-white">
              <div className="text-center">
                <Spinner size={8} />
                <p className="mt-3 text-sm font-semibold text-slate-700">Procesando con Gemini...</p>
                <p className="mt-1 text-xs text-slate-400">Extrayendo campos del siniestro</p>
              </div>
            </div>
          )}

          {stage === "error" && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5">
              <p className="text-sm font-semibold text-red-700">Error al analizar</p>
              <p className="mt-1 text-sm text-red-600">{errorMsg}</p>
            </div>
          )}

          {stage === "done" && result && (
            <ResultPanel result={result} elapsed={elapsed} />
          )}
        </div>
      </div>

      {/* FNOL flow diagram */}
      <FNOLFlow />
    </div>
  );
}
