"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/LocaleContext";

type TrainingState = "idle" | "loading" | "saving" | "success" | "error";

interface Template {
  label: string;
  description: string;
  content: string;
}

const TEMPLATES: Template[] = [
  {
    label: "Extracción estándar",
    description: "Guía general para mejorar la precisión de extracción",
    content: `Guía de extracción para este tenant:
- Para emails con sección "Datos del asegurado", extraer nombre completo como full_name y número de póliza como policy_number con confianza alta.
- Si "Documentación adjunta" lista fotos, licencia o denuncia policial, marcar esos documentos como presentes en fields[].
- Para un choque entre dos autos con patentes y sin heridos, la severidad suele ser medium.
- Pedir confirmación solo cuando un valor sea ambiguo o entre en conflicto con datos guardados de cliente/póliza.
- Si el email es solo un agradecimiento, consulta de precio o renovación de póliza, marcar is_claim=false.
- Ignorar emails de publicidad o boletines aunque mencionen siniestros de forma genérica.`,
  },
  {
    label: "Campos personalizados",
    description: "Define nuevos campos para extraer además de los estándar",
    content: `Campos adicionales a extraer (además de los campos estándar):
- extract \`numero_siniestro\`: número de siniestro o expediente asignado por la aseguradora (ej: "Siniestro Nro: 12345")
- extract \`patente_vehicle\`: patente del vehículo en formato argentino (ej: "ABC 123" o "AB123CD")
- extract \`marca_modelo\`: marca y modelo del vehículo (ej: "Toyota Corolla 2020")
- extract \`año_vehicle\`: año de fabricación del vehículo si se menciona

Para cada campo: si está presente con certeza → confidence 0.90+. Si está insinuado o parcial → confidence 0.70. Si no aparece en el email → omitir del array fields[].`,
  },
  {
    label: "Seguros de hogar",
    description: "Reglas para tenants que operan seguros de hogar además de autos",
    content: `Este tenant maneja seguros de HOGAR además de autos. Reglas adicionales:
- claim_type puede ser: incendio_hogar, inundacion, robo_hogar, daño_propiedad, o any para siniestros de inmuebles.
- Para incendio_hogar, severidad siempre high o critical.
- extract \`direccion_siniestro\`: dirección completa del inmueble afectado.
- extract \`tipo_inmueble\`: casa, departamento, local comercial, galpón, etc.
- extract \`superficie_m2\`: superficie en metros cuadrados si se menciona.
- Si el email menciona "informe de bomberos", "peritaje" o "tasación", agregar a fields[] con key \`informe_requerido\` = "si" y confidence 0.90.
- Si hay fotos del inmueble adjuntas, agregar \`fotos_inmueble\` = "si".`,
  },
  {
    label: "Severidad personalizada",
    description: "Ajusta cómo el agente clasifica la gravedad de los siniestros",
    content: `Reglas de severidad personalizadas para este tenant:
- Si el email menciona "ambulancia", "internación" o "heridos graves" → severity = critical (independientemente de otros indicadores).
- Si menciona "tercero herido" o "lesiones leves" → severity = high como mínimo.
- Si el asegurado indica explícitamente "sin heridos" y "solo daños materiales" → usar medium aunque haya choque.
- Motos y ciclomotores: elevar la severidad base un nivel (low→medium, medium→high, high→critical) por mayor riesgo de lesiones.
- Vehículos de empresa o flotas (mencionados como "auto de la empresa", "unidad Nro"): elevar un nivel sobre la severidad base.
- Si el email fue enviado fuera del horario laboral (detectable por hora en cabecera), no modificar la severidad — es solo información.`,
  },
];

export function AgentTrainingPanel() {
  const t = useT();
  const [content, setContent] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState<TrainingState>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);

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
    return () => { cancelled = true; };
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

  function applyTemplate(template: Template) {
    setContent((prev) =>
      prev.trim()
        ? `${prev.trim()}\n\n=== ${template.label} ===\n${template.content}`
        : template.content
    );
    setShowTemplates(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="agent_training" className="text-sm font-medium text-slate-700">
          {t("configuracion.agentTraining.label")}
        </label>
        <div className="flex items-center gap-3">
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
      </div>

      {/* Templates */}
      <div className="rounded-md border border-slate-200 bg-slate-50">
        <button
          type="button"
          onClick={() => setShowTemplates((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2.5 text-left text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          <span>Plantillas de entrenamiento</span>
          <svg
            className={`h-3.5 w-3.5 transition-transform ${showTemplates ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showTemplates && (
          <div className="border-t border-slate-200 divide-y divide-slate-100">
            {TEMPLATES.map((tpl) => (
              <div key={tpl.label} className="flex items-start justify-between gap-3 px-3 py-2.5">
                <div>
                  <p className="text-xs font-medium text-slate-700">{tpl.label}</p>
                  <p className="text-xs text-slate-400">{tpl.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => applyTemplate(tpl)}
                  className="flex-shrink-0 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100"
                >
                  Usar
                </button>
              </div>
            ))}
            <div className="px-3 py-2 text-xs text-slate-400">
              Al hacer clic en "Usar" la plantilla se agrega al texto actual. Podés combinar varias.
            </div>
          </div>
        )}
      </div>

      {/* Textarea */}
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
