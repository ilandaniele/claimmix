/**
 * Análisis page — W7 supplemental pages.
 *
 * Shows aggregated statistics about cases across time periods.
 * Server Component — fetches data directly from Supabase via the server client.
 * RLS ensures only the current tenant's cases are visible.
 */

import { createServerClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";
import { redirect } from "next/navigation";

// ── Status and type labels ─────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  listo: "Listos",
  esperando: "Esperando",
  escalado: "Escalados",
  procesando: "Procesando",
  cerrado: "Cerrados",
};

const TYPE_LABELS: Record<string, string> = {
  choque: "Choque",
  robo: "Robo",
  granizo: "Granizo",
  incendio: "Incendio",
};

// ── Data fetching ─────────────────────────────────────────────────────────────

interface AnalisisData {
  total: number;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  avg_confidence: number | null;
  recent_7_days: number;
  recent_30_days: number;
}

async function fetchAnalisis(): Promise<AnalisisData | null> {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (!user || authErr) return null;

    const now = new Date();
    const day7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const day30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [allCasesRes, recent7Res, recent30Res] = await Promise.all([
       
      (supabase as any)
        .from("cases")
        .select("status, claim_type, confidence_min"),
       
      (supabase as any)
        .from("cases")
        .select("id", { count: "exact" })
        .gte("created_at", day7),
       
      (supabase as any)
        .from("cases")
        .select("id", { count: "exact" })
        .gte("created_at", day30),
    ]);

    const allCases: Array<{
      status: string;
      claim_type: string;
      confidence_min: number | null;
    }> = allCasesRes.data ?? [];

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let confSum = 0;
    let confCount = 0;

    for (const c of allCases) {
      byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
      byType[c.claim_type] = (byType[c.claim_type] ?? 0) + 1;
      if (c.confidence_min !== null) {
        confSum += c.confidence_min;
        confCount++;
      }
    }

    return {
      total: allCases.length,
      by_status: byStatus,
      by_type: byType,
      avg_confidence: confCount > 0 ? Math.round((confSum / confCount) * 100) / 100 : null,
      recent_7_days: recent7Res.count ?? 0,
      recent_30_days: recent30Res.count ?? 0,
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    console.error("[analisis] fetch error:", e instanceof Error ? e.name : "unknown");
    return null;
  }
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-3xl font-bold text-slate-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

// ── Distribution row ──────────────────────────────────────────────────────────

function DistributionRow({
  label,
  count,
  total,
  colorClass,
}: {
  label: string;
  count: number;
  total: number;
  colorClass: string;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 flex-none text-right text-xs text-slate-500">{label}</div>
      <div className="flex-1">
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full ${colorClass}`}
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={label}
          />
        </div>
      </div>
      <div className="w-16 flex-none text-right text-xs font-medium text-slate-700">
        {count} ({pct}%)
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AnalisisPage() {
  let data: AnalisisData | null;
  try {
    data = await fetchAnalisis();
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") {
      redirect("/login");
    }
    data = null;
  }

  const hasData = data && data.total > 0;
  const totalByType = Object.values(data?.by_type ?? {}).reduce((a, b) => a + b, 0);
  const totalByStatus = Object.values(data?.by_status ?? {}).reduce((a, b) => a + b, 0);

  return (
    <div className="px-6 py-8 max-w-5xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-slate-900">Análisis</h1>
        <p className="mt-1 text-sm text-slate-500">
          Estadísticas agregadas de siniestros
        </p>
      </div>

      {!hasData ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-6 py-12 text-center">
          <p className="text-sm text-slate-500">
            No hay datos disponibles para el período seleccionado.
          </p>
        </div>
      ) : (
        <>
          {/* Summary stats */}
          <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Total de siniestros"
              value={String(data!.total)}
              sub="histórico"
            />
            <StatCard
              label="Últimos 7 días"
              value={String(data!.recent_7_days)}
              sub="ingresados"
            />
            <StatCard
              label="Últimos 30 días"
              value={String(data!.recent_30_days)}
              sub="ingresados"
            />
            <StatCard
              label="Confianza media"
              value={
                data!.avg_confidence !== null
                  ? `${Math.round(data!.avg_confidence * 100)}%`
                  : "—"
              }
              sub="score de extracción IA"
            />
          </div>

          {/* Distribution charts */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* By type */}
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="mb-5 text-sm font-semibold text-slate-700">
                Distribución por tipo
              </h2>
              <div className="space-y-3">
                {Object.entries(TYPE_LABELS).map(([key, label]) => (
                  <DistributionRow
                    key={key}
                    label={label}
                    count={data!.by_type[key] ?? 0}
                    total={totalByType}
                    colorClass={
                      key === "choque"
                        ? "bg-blue-500"
                        : key === "robo"
                          ? "bg-purple-500"
                          : key === "granizo"
                            ? "bg-cyan-500"
                            : "bg-orange-500"
                    }
                  />
                ))}
              </div>
            </div>

            {/* By status */}
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="mb-5 text-sm font-semibold text-slate-700">
                Distribución por estado
              </h2>
              <div className="space-y-3">
                {Object.entries(STATUS_LABELS).map(([key, label]) => (
                  <DistributionRow
                    key={key}
                    label={label}
                    count={data!.by_status[key] ?? 0}
                    total={totalByStatus}
                    colorClass={
                      key === "listo"
                        ? "bg-green-500"
                        : key === "esperando"
                          ? "bg-yellow-400"
                          : key === "escalado"
                            ? "bg-red-400"
                            : key === "procesando"
                              ? "bg-blue-400"
                              : "bg-slate-400"
                    }
                  />
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
