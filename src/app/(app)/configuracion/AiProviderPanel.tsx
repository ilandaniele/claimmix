"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/LocaleContext";

type ProviderId = "openai" | "gemini";

type ProviderInfo = {
  configured: boolean;
  model: string;
};

type SettingsResponse = {
  provider: ProviderId;
  providers: Record<ProviderId, ProviderInfo>;
};

const PROVIDER_ORDER: ProviderId[] = ["openai", "gemini"];

export function AiProviderPanel() {
  const t = useT();
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [providers, setProviders] = useState<Record<ProviderId, ProviderInfo> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/ai-settings", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("load_failed");
        return res.json();
      })
      .then((body: { data?: SettingsResponse } & SettingsResponse) => {
        if (cancelled) return;
        const payload = body.data ?? body;
        setProvider(payload.provider);
        setProviders(payload.providers);
        setError("");
      })
      .catch(() => {
        if (!cancelled) setError(t("aiProvider.loadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  async function selectProvider(next: ProviderId) {
    if (next === provider || saving) return;
    setSaving(true);
    setSaved(false);
    setError("");
    const previous = provider;
    setProvider(next);

    try {
      const res = await fetch("/api/admin/ai-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setProvider(previous);
        setError(body?.error?.message ?? t("aiProvider.saveError"));
        return;
      }
      setSaved(true);
    } catch {
      setProvider(previous);
      setError(t("aiProvider.saveError"));
    } finally {
      setSaving(false);
    }
  }

  const labels: Record<ProviderId, { name: string; helper: string }> = {
    openai: { name: "OpenAI", helper: t("aiProvider.openaiHelper") },
    gemini: { name: "Google Gemini", helper: t("aiProvider.geminiHelper") },
  };

  if (loading) {
    return <p className="text-sm text-slate-500">{t("aiProvider.loading")}</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">{t("aiProvider.helper")}</p>

      {error && (
        <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label={t("aiProvider.title")}>
        {PROVIDER_ORDER.map((id) => {
          const info = providers?.[id];
          const active = provider === id;
          const disabled = saving || !info?.configured;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled && !active}
              onClick={() => selectProvider(id)}
              className={`rounded-lg border px-4 py-3 text-left transition ${
                active
                  ? "border-slate-800 bg-slate-50 ring-1 ring-slate-800"
                  : "border-slate-200 bg-white hover:border-slate-400"
              } ${disabled && !active ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-800">
                  {labels[id].name}
                </span>
                {active && (
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
                    {t("aiProvider.active")}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500">{labels[id].helper}</p>
              <p className="mt-2 font-mono text-[11px] text-slate-400">
                {info?.model ?? "—"}
              </p>
              {!info?.configured && (
                <p className="mt-1 text-[11px] font-medium text-amber-600">
                  {t("aiProvider.notConfigured")}
                </p>
              )}
            </button>
          );
        })}
      </div>

      {saved && (
        <p className="text-xs text-emerald-600" role="status">
          {t("aiProvider.saved")}
        </p>
      )}
    </div>
  );
}
