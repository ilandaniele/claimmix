"use client";

/**
 * PromptRulesPanel — "Consola de entrenamiento del agente" (Agent Training
 * Console). Lists tenant agent_prompt_rules, allows creating new rules and
 * activating/deactivating existing ones. Active rules are injected into the
 * extraction prompt for future emails; rules never modify source code.
 */

import { useEffect, useState } from "react";

interface PromptRule {
  id: string;
  title: string;
  rule_text: string;
  rule_type: string;
  active: boolean;
  created_at: string;
  updated_at: string | null;
}

type PanelState = "loading" | "ready" | "error";

const RULE_TYPE_LABELS: Record<string, string> = {
  extraction: "Extracción",
  classification: "Clasificación",
  severity: "Severidad",
  missing_fields: "Campos faltantes",
  reply_style: "Estilo de respuesta",
  core_mapping: "Mapeo a core",
};

const PLACEHOLDER_EXAMPLES =
  'Ej.: "Si el email menciona choque, clasificar como choque" · "Si hay personas heridas, severidad high o critical" · "Nunca marcar listo si falta DNI o número de póliza"';

async function fetchRules(): Promise<PromptRule[]> {
  const res = await fetch("/api/admin/prompt-rules", { cache: "no-store" });
  if (!res.ok) throw new Error("load_failed");
  const body = await res.json();
  return body.rules ?? [];
}

export function PromptRulesPanel() {
  const [rules, setRules] = useState<PromptRule[]>([]);
  const [state, setState] = useState<PanelState>("loading");
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const [title, setTitle] = useState("");
  const [ruleText, setRuleText] = useState("");
  const [ruleType, setRuleType] = useState("extraction");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const fresh = await fetchRules();
        if (cancelled) return;
        setRules(fresh);
        setState("ready");
      } catch {
        if (!cancelled) {
          setState("error");
          setErrorMsg("No se pudieron cargar las reglas.");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");
    if (title.trim().length < 3 || ruleText.trim().length < 3) {
      setErrorMsg("Completá el título y el texto de la regla (mínimo 3 caracteres).");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/prompt-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          rule_text: ruleText.trim(),
          rule_type: ruleType,
          active: true,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? "create_failed");
      }
      setTitle("");
      setRuleText("");
      setSuccessMsg("Regla creada. Se aplicará en las próximas extracciones.");
      setRules(await fetchRules());
    } catch (err) {
      setErrorMsg(
        err instanceof Error && err.message !== "create_failed"
          ? err.message
          : "No se pudo crear la regla."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(rule: PromptRule) {
    setErrorMsg("");
    setSuccessMsg("");
    setTogglingId(rule.id);
    try {
      const res = await fetch(`/api/admin/prompt-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !rule.active }),
      });
      if (!res.ok) throw new Error("toggle_failed");
      const body = await res.json();
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, ...body.rule } : r))
      );
    } catch {
      setErrorMsg("No se pudo actualizar la regla.");
    } finally {
      setTogglingId(null);
    }
  }

  if (state === "loading") {
    return (
      <div className="space-y-2 animate-pulse" aria-busy="true">
        <div className="h-4 w-48 rounded bg-slate-200" />
        <div className="h-20 w-full rounded bg-slate-100" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Create rule form */}
      <form onSubmit={handleCreate} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título de la regla"
            maxLength={200}
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          />
          <select
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value)}
            className="rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
            aria-label="Tipo de regla"
          >
            {Object.entries(RULE_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <textarea
          value={ruleText}
          onChange={(e) => setRuleText(e.target.value)}
          placeholder={PLACEHOLDER_EXAMPLES}
          maxLength={2000}
          className="min-h-24 w-full rounded-md border border-slate-200 px-3 py-2 text-sm leading-relaxed text-slate-900 focus:border-slate-400 focus:outline-none"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            Las reglas activas se incluyen en el prompt del agente para las
            próximas extracciones. Cada cambio queda auditado.
          </p>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {submitting ? "Guardando…" : "Agregar regla"}
          </button>
        </div>
      </form>

      {successMsg && (
        <div role="status" className="rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">
          {successMsg}
        </div>
      )}
      {errorMsg && (
        <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {errorMsg}
        </div>
      )}

      {/* Rules list */}
      {rules.length === 0 ? (
        <p className="text-sm text-slate-400">
          Todavía no hay reglas de entrenamiento.
        </p>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800">
                    {rule.title}
                  </span>
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {RULE_TYPE_LABELS[rule.rule_type] ?? rule.rule_type}
                  </span>
                  {!rule.active && (
                    <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                      Inactiva
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-600 whitespace-pre-wrap">
                  {rule.rule_text}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleToggle(rule)}
                disabled={togglingId === rule.id}
                className={`flex-shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  rule.active
                    ? "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    : "bg-green-600 text-white hover:bg-green-700"
                }`}
              >
                {togglingId === rule.id
                  ? "…"
                  : rule.active
                    ? "Desactivar"
                    : "Activar"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
