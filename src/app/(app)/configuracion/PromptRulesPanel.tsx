"use client";

/**
 * PromptRulesPanel — "Consola de entrenamiento del agente" (Agent Training
 * Console). Lists tenant agent_prompt_rules, allows creating new rules and
 * activating/deactivating existing ones. Active rules are injected into the
 * extraction prompt for future emails; rules never modify source code.
 */

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n/LocaleContext";
import type { TranslationKey } from "@/lib/i18n";

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

/*
 * La etiqueta es una CLAVE: la tabla es de modulo y se arma antes de que
 * exista un idioma. Se traduce donde se dibuja.
 *
 * `rule_type` es `text` en la base, no un enum, asi que un tipo que no este
 * aca se muestra crudo antes que dejar el lugar vacio.
 */
const RULE_TYPE_LABELS: Record<string, TranslationKey> = {
  extraction: "reglas.tipo.extraction",
  classification: "reglas.tipo.classification",
  severity: "reglas.tipo.severity",
  missing_fields: "reglas.tipo.missing_fields",
  reply_style: "reglas.tipo.reply_style",
  core_mapping: "reglas.tipo.core_mapping",
};

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
  const t = useT();

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
          setErrorMsg(t("reglas.errorCarga"));
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // `t` cambia con el idioma; el mensaje ya escrito no se retraduce solo, y
    // volver a pedir las reglas por eso seria peor que el problema.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");
    if (title.trim().length < 3 || ruleText.trim().length < 3) {
      setErrorMsg(t("reglas.errorCampos"));
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
      setSuccessMsg(t("reglas.creada"));
      setRules(await fetchRules());
    } catch (err) {
      setErrorMsg(
        err instanceof Error && err.message !== "create_failed"
          ? err.message
          : t("reglas.errorCrear")
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
      setErrorMsg(t("reglas.errorActualizar"));
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
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,auto)]">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("reglas.phTitulo")}
            maxLength={200}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-100 dark:placeholder:text-slate-500"
          />
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("reglas.tipoRegla")}>
            {Object.entries(RULE_TYPE_LABELS).map(([value, clave]) => (
              <button
                key={value}
                type="button"
                onClick={() => setRuleType(value)}
                aria-pressed={ruleType === value}
                className={[
                  "rounded-md border px-3 py-2 text-xs font-medium transition-colors",
                  ruleType === value
                    ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800",
                ].join(" ")}
              >
                {t(clave)}
              </button>
            ))}
          </div>
        </div>
        <textarea
          value={ruleText}
          onChange={(e) => setRuleText(e.target.value)}
          placeholder={t("reglas.placeholder")}
          maxLength={2000}
          className="min-h-24 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-100 dark:placeholder:text-slate-500"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t("reglas.ayuda")}
          </p>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          >
            {submitting ? t("reglas.guardando") : t("reglas.agregar")}
          </button>
        </div>
      </form>

      {successMsg && (
        <div role="status" className="rounded-md bg-green-50 px-3 py-2 text-xs text-green-700 dark:bg-green-950/50 dark:text-green-200">
          {successMsg}
        </div>
      )}
      {errorMsg && (
        <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-200">
          {errorMsg}
        </div>
      )}

      {/* Rules list */}
      {rules.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          {t("reglas.vacio")}
        </p>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 px-4 py-3 dark:border-slate-700 dark:bg-slate-950/30"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {rule.title}
                  </span>
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {RULE_TYPE_LABELS[rule.rule_type]
                      ? t(RULE_TYPE_LABELS[rule.rule_type])
                      : rule.rule_type}
                  </span>
                  {!rule.active && (
                    <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
                      {t("reglas.inactiva")}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-600 whitespace-pre-wrap dark:text-slate-300">
                  {rule.rule_text}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleToggle(rule)}
                disabled={togglingId === rule.id}
                className={`flex-shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  rule.active
                    ? "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                    : "bg-green-600 text-white hover:bg-green-700"
                }`}
              >
                {togglingId === rule.id
                  ? "…"
                  : rule.active
                    ? t("reglas.desactivar")
                    : t("reglas.activar")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
