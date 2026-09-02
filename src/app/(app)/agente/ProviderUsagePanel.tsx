"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { useLocale } from "@/lib/i18n/LocaleContext";
import { ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";

type Stats24h = {
  provider: string;
  model: string;
  total: number;
  success: number;
  error: number;
  rate_limited: number;
  quota_exceeded: number;
  invalid_json: number;
  avg_latency_ms: number | null;
};

type Stats7d = {
  provider: string;
  total: number;
  failures: number;
  rate_limited: number;
};

type RecentError = {
  provider: string;
  model: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  latency_ms: number | null;
  created_at: string;
};

type GeminiConfig = {
  min_request_interval_ms: number;
  max_retries: number;
  retry_base_ms: number;
  worker_concurrency: number;
  worker_delay_ms: number;
};

type UsageData = {
  stats_24h: Stats24h[];
  stats_7d: Stats7d[];
  recent_errors: RecentError[];
  gemini_config: GeminiConfig;
};

function statusColor(status: string) {
  if (status === "success") return "text-emerald-600 dark:text-emerald-400";
  if (status === "rate_limited" || status === "quota_exceeded")
    return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export function ProviderUsagePanel() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const { locale, t } = useLocale();

  async function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch("/api/admin/provider-usage", { cache: "no-store" });
      if (!res.ok) throw new Error("load_failed");
      const body = await res.json();
      setData(body);
      setError("");
    } catch {
      setError(t("uso.errorCarga"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/provider-usage", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load_failed"))))
      .then((body: UsageData) => {
        if (!cancelled) { setData(body); setError(""); }
      })
      .catch(() => {
        if (!cancelled) setError(t("uso.errorCarga"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // `t` cambia con el idioma; el mensaje ya escrito no se retraduce solo, y
    // volver a pedir las estadisticas por eso seria peor que el problema.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p className="text-sm text-slate-500">{t("uso.cargando")}</p>;

  if (error) {
    return (
      <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-200">
        {error}
      </div>
    );
  }

  if (!data) return null;

  const { stats_24h, stats_7d, recent_errors, gemini_config } = data;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
            {t("uso.titulo")}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t("uso.subtitulo")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300"
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
          {t("uso.actualizar")}
        </button>
      </div>

      {/* ── 24 h stats ── */}
      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t("uso.ultimas24")}
        </p>
        {stats_24h.length === 0 ? (
          <p className="text-xs text-slate-500">{t("uso.sinLlamadas")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  <th className="pb-1.5 pr-3 font-medium">{t("uso.col.proveedor")}</th>
                  <th className="pb-1.5 pr-3 font-medium">{t("uso.col.modelo")}</th>
                  <th className="pb-1.5 pr-3 text-right font-medium">{t("uso.col.total")}</th>
                  <th className="pb-1.5 pr-3 text-right font-medium">{t("uso.col.ok")}</th>
                  <th className="pb-1.5 pr-3 text-right font-medium">{t("uso.col.error")}</th>
                  <th className="pb-1.5 pr-3 text-right font-medium">{t("uso.col.rateLimit")}</th>
                  <th className="pb-1.5 pr-3 text-right font-medium">{t("uso.col.cuota")}</th>
                  <th className="pb-1.5 text-right font-medium">{t("uso.col.latencia")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {stats_24h.map((row, i) => (
                  <tr key={i} className="text-slate-700 dark:text-slate-300">
                    <td className="py-1.5 pr-3 font-medium">{row.provider}</td>
                    <td className="py-1.5 pr-3 font-mono text-slate-500 dark:text-slate-400">
                      {row.model.split("/").at(-1)}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{row.total}</td>
                    <td className="py-1.5 pr-3 text-right text-emerald-600 dark:text-emerald-400">
                      {row.success}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-red-600 dark:text-red-400">
                      {row.error > 0 ? row.error : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-amber-600 dark:text-amber-400">
                      {row.rate_limited > 0 ? row.rate_limited : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-amber-600 dark:text-amber-400">
                      {row.quota_exceeded > 0 ? row.quota_exceeded : "—"}
                    </td>
                    <td className="py-1.5 text-right text-slate-500 dark:text-slate-400">
                      {row.avg_latency_ms != null ? `${row.avg_latency_ms} ms` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 7-day summary ── */}
      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t("uso.ultimos7")}
        </p>
        {stats_7d.length === 0 ? (
          <p className="text-xs text-slate-500">{t("uso.sinLlamadas")}</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {stats_7d.map((row, i) => (
              <div
                key={i}
                className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-900/40"
              >
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  {row.provider}
                </p>
                <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
                  {row.total.toLocaleString(locale)}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {row.failures > 0 ? (
                    <span className="text-red-600 dark:text-red-400">
                      {row.failures === 1
                        ? t("uso.erroresUno")
                        : t("uso.erroresVarios").replace("{n}", String(row.failures))}
                    </span>
                  ) : (
                    t("uso.sinErrores")
                  )}
                  {row.rate_limited > 0 && (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">
                      {t("uso.rateLimited").replace("{n}", String(row.rate_limited))}
                    </span>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Recent errors ── */}
      {recent_errors.length > 0 && (
        <section className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t("uso.erroresRecientes")}
          </p>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            {recent_errors.map((e, i) => (
              <li key={i} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`font-medium ${statusColor(e.status)}`}>{e.status}</span>
                  <span className="text-slate-600 dark:text-slate-300">{e.provider}</span>
                  {e.error_code && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {e.error_code}
                    </span>
                  )}
                  <span className="ml-auto text-slate-400 dark:text-slate-500">
                    {/*
                      * La hora se dice en el idioma de quien mira y en la
                      * zona del negocio. Sin argumentos tomaba las dos del
                      * navegador: un operador que abre esto de viaje veia la
                      * hora de donde esta parado, y comparaba esa hora contra
                      * el resto del producto, que esta fijado a Buenos Aires.
                      */}
                    {new Date(e.created_at).toLocaleTimeString(locale, {
                      timeZone: ZONA_ARGENTINA,
                    })}
                  </span>
                </div>
                {e.error_message && (
                  <p className="mt-0.5 truncate text-slate-500 dark:text-slate-400">
                    {e.error_message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Gemini worker config ── */}
      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t("uso.config")}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            { label: t("uso.cfg.intervalo"), value: `${gemini_config.min_request_interval_ms} ms` },
            { label: t("uso.cfg.reintentos"), value: String(gemini_config.max_retries) },
            { label: t("uso.cfg.backoff"), value: `${gemini_config.retry_base_ms} ms` },
            { label: t("uso.cfg.concurrencia"), value: String(gemini_config.worker_concurrency) },
            { label: t("uso.cfg.delay"), value: `${gemini_config.worker_delay_ms} ms` },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/40"
            >
              <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
              <p className="font-mono text-sm font-semibold text-slate-800 dark:text-slate-100">
                {value}
              </p>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("uso.cfg.configurable")}{" "}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">
            GEMINI_MIN_REQUEST_INTERVAL_MS
          </code>
          ,{" "}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">
            GEMINI_WORKER_CONCURRENCY
          </code>{" "}
          {t("uso.cfg.yOtras")}
        </p>
      </section>
    </div>
  );
}
