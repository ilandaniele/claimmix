"use client";

import { useState } from "react";
import { Play, CheckCircle, AlertCircle } from "lucide-react";
import type { ClaimType } from "@/lib/schemas/cases";
import { useT } from "@/lib/i18n/LocaleContext";
import type { TranslationKey } from "@/lib/i18n";

/*
 * Los tipos son los MISMOS `type.*` que usan los filtros de la bandeja, no una
 * lista propia. Estaban escritos dos veces con nombres distintos —aca
 * «Responsabilidad civil», alla «Resp. Civil»— para exactamente la misma cosa.
 *
 * La lista se arma al cargar el modulo, cuando todavia no hay locale ni hook,
 * asi que la etiqueta es una CLAVE y se traduce en el `map` de abajo.
 */
const CLAIM_TYPES: { value: ClaimType | ""; clave: TranslationKey }[] = [
  { value: "", clave: "lote.aleatorio" },
  { value: "choque", clave: "type.choque" },
  { value: "robo", clave: "type.robo" },
  { value: "granizo", clave: "type.granizo" },
  { value: "incendio", clave: "type.incendio" },
  { value: "cristales", clave: "type.cristales" },
  { value: "rc", clave: "type.rc" },
  { value: "robo_contenido", clave: "type.robo_contenido" },
  { value: "accidente_personal", clave: "type.accidente_personal" },
];

type BatchResult = {
  accepted: number;
  case_ids: string[];
  message: string;
};

export function BatchSimulatePanel() {
  const [count, setCount] = useState(5);
  const [delayMs, setDelayMs] = useState(1500);
  const [claimType, setClaimType] = useState<ClaimType | "">("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState("");
  const t = useT();

  async function run() {
    setRunning(true);
    setResult(null);
    setError("");

    try {
      const body: Record<string, unknown> = { count, delay_ms: delayMs };
      if (claimType) body.claim_type = claimType;

      const res = await fetch("/api/admin/batch-simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      let data: Record<string, unknown> | null = null;
      try {
        data = await res.json();
      } catch {
        // non-JSON error body (e.g. HTML error page from proxy)
      }

      if (!res.ok) {
        const msg = (data as { error?: { message?: string } } | null)?.error?.message;
        setError(msg ?? t("lote.errorHttp").replace("{n}", String(res.status)));
        return;
      }

      setResult(data as unknown as BatchResult);
    } catch {
      setError(t("lote.errorRed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {t("lote.titulo")}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("lote.descripcion")}
        </p>
      </div>

      {/* ── Config ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
            {t("lote.cantidad")}
          </label>
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value))))}
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
            {t("lote.delay")}
          </label>
          <input
            type="number"
            min={0}
            max={5000}
            step={100}
            value={delayMs}
            onChange={(e) => setDelayMs(Math.max(0, Math.min(5000, Number(e.target.value))))}
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
            {t("lote.tipo")}
          </label>
          <select
            value={claimType}
            onChange={(e) => setClaimType(e.target.value as ClaimType | "")}
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            {CLAIM_TYPES.map(({ value, clave }) => (
              <option key={value || "random"} value={value}>
                {t(clave)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <button
        type="button"
        onClick={run}
        disabled={running}
        className="flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
      >
        <Play size={14} />
        {running
          ? t("lote.iniciando")
          : count === 1
            ? t("lote.iniciarUna")
            : t("lote.iniciarVarias").replace("{n}", String(count))}
      </button>

      {result && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm dark:border-emerald-800 dark:bg-emerald-950/40">
          <CheckCircle size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="font-medium text-emerald-800 dark:text-emerald-300">
              {result.accepted === 1
                ? t("lote.iniciadaUna")
                : t("lote.iniciadasVarias").replace("{n}", String(result.accepted))}
            </p>
            <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-400">
              {result.message}
            </p>
            <p className="mt-1 font-mono text-xs text-emerald-600 dark:text-emerald-500">
              {result.case_ids.slice(0, 3).join(", ")}
              {result.case_ids.length > 3 &&
                " " + t("lote.mas").replace("{n}", String(result.case_ids.length - 3))}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle size={14} className="shrink-0" />
          {error}
        </div>
      )}

      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <strong>{t("lote.limiteRotulo")}</strong> {t("lote.limite")}
      </div>
    </div>
  );
}
