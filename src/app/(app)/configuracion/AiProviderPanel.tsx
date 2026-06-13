"use client";

import { useEffect, useRef, useState } from "react";
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

  // Gemini key form state
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [geminiKey, setGeminiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);

  function applyPayload(payload: SettingsResponse) {
    setProvider(payload.provider);
    setProviders(payload.providers);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/ai-settings", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("load_failed");
        return res.json();
      })
      .then((body: { data?: SettingsResponse } & SettingsResponse) => {
        if (cancelled) return;
        applyPayload(body.data ?? body);
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

  // Auto-focus key input when shown
  useEffect(() => {
    if (showKeyForm) keyInputRef.current?.focus();
  }, [showKeyForm]);

  async function selectProvider(next: ProviderId) {
    if (next === provider || saving) return;
    const info = providers?.[next];
    if (!info?.configured) {
      if (next === "gemini") {
        setShowKeyForm(true);
        return;
      }
      return;
    }
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
      const body = (await res.json()) as { data?: SettingsResponse } & SettingsResponse;
      applyPayload(body.data ?? body);
      setSaved(true);
    } catch {
      setProvider(previous);
      setError(t("aiProvider.saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function saveGeminiKey() {
    if (!geminiKey.trim() || savingKey) return;
    setSavingKey(true);
    setKeyError("");
    setKeySaved(false);

    try {
      const res = await fetch("/api/admin/ai-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiKey: geminiKey.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setKeyError(body?.error?.message ?? t("aiProvider.keySaveError"));
        return;
      }
      const body = (await res.json()) as { data?: SettingsResponse } & SettingsResponse;
      applyPayload(body.data ?? body);
      setGeminiKey("");
      setShowKeyForm(false);
      setKeySaved(true);
    } catch {
      setKeyError(t("aiProvider.keySaveError"));
    } finally {
      setSavingKey(false);
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
          const configured = Boolean(info?.configured);
          const disabled = saving || (!configured && id !== "gemini");
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
              {!configured && (
                <p className="mt-1 text-[11px] font-medium text-amber-600">
                  {t("aiProvider.notConfigured")}
                  {id === "gemini" && (
                    <span className="ml-1 underline">
                      — {t("aiProvider.configureKey")}
                    </span>
                  )}
                </p>
              )}
            </button>
          );
        })}
      </div>

      {/* Gemini API key input — shown when not configured or user clicked the card */}
      {showKeyForm && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
          <label className="block text-sm font-medium text-slate-700">
            {t("aiProvider.geminiKeyLabel")}
          </label>
          <div className="flex gap-2">
            <input
              ref={keyInputRef}
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveGeminiKey()}
              placeholder={t("aiProvider.geminiKeyPlaceholder")}
              className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-600 focus:outline-none focus:ring-1 focus:ring-slate-600"
              disabled={savingKey}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={saveGeminiKey}
              disabled={!geminiKey.trim() || savingKey}
              className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-slate-700"
            >
              {savingKey ? "…" : t("aiProvider.saveKey")}
            </button>
            <button
              type="button"
              onClick={() => { setShowKeyForm(false); setKeyError(""); setGeminiKey(""); }}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              ✕
            </button>
          </div>
          {keyError && (
            <p className="text-xs text-red-600">{keyError}</p>
          )}
        </div>
      )}

      {/* Show "Add API key" link when Gemini is not configured and form is hidden */}
      {!showKeyForm && !providers?.gemini.configured && (
        <button
          type="button"
          onClick={() => setShowKeyForm(true)}
          className="text-xs text-slate-500 underline hover:text-slate-700"
        >
          {t("aiProvider.configureKey")} (Gemini)
        </button>
      )}

      {keySaved && !showKeyForm && (
        <p className="text-xs text-emerald-600" role="status">
          {t("aiProvider.keySaved")}
        </p>
      )}

      {saved && (
        <p className="text-xs text-emerald-600" role="status">
          {t("aiProvider.saved")}
        </p>
      )}
    </div>
  );
}
