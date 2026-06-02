/**
 * Métricas page — AC16 supplemental pages (W7).
 *
 * Server Component that fetches KPI data from /api/metricas and renders:
 *   - 4 summary cards
 *   - Cases by status (visual bar chart — HTML/CSS only, no chart library)
 *   - Cases by type (donut-style percentage bars)
 *   - Top 5 analysts table
 *
 * All numbers in Spanish (es-AR). Empty state shown when no data exists.
 */

import { createServerClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";
import { redirect } from "next/navigation";

// ── Data fetching ─────────────────────────────────────────────────────────────

interface MetricasSummary {
  total_cases_month: number;
  avg_opening_time_minutes: number | null;
  auto_completion_rate: number;
  escalated_count: number;
}

interface MetricasData {
  summary: MetricasSummary;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  top_analysts: Array<{ full_name: string; closed_count: number }>;
  period: { start: string; end: string };
}

async function fetchMetricas(): Promise<MetricasData | null> {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return null;

    // ── Date window ────────────────────────────────────────────────────────────
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    const [casesMonthRes, byStatusRes, byTypeRes, escalatedRes, topAnalystsRes] =
      await Promise.all([
         
        (supabase as any)
          .from("cases")
          .select("id, status, created_at, closed_at")
          .gte("created_at", monthStart)
          .lt("created_at", monthEnd),
         
        (supabase as any).from("cases").select("status"),
         
        (supabase as any).from("cases").select("claim_type"),
         
        (supabase as any)
          .from("cases")
          .select("id", { count: "exact" })
          .eq("status", "escalado")
          .gte("created_at", monthStart)
          .lt("created_at", monthEnd),
         
        (supabase as any)
          .from("cases")
          .select("assigned_to, users!cases_assigned_to_fkey(full_name)")
          .eq("status", "cerrado")
          .gte("closed_at", monthStart)
          .lt("closed_at", monthEnd),
      ]);

    const casesThisMonth: Array<{
      id: string;
      status: string;
      created_at: string;
      closed_at: string | null;
    }> = casesMonthRes.data ?? [];

    const totalCasesMonth = casesThisMonth.length;

    // Avg opening time
    const closedCases = casesThisMonth.filter(
      (c) => c.status === "cerrado" && c.closed_at
    );
    let avgOpeningMinutes: number | null = null;
    if (closedCases.length > 0) {
      const total = closedCases.reduce((s, c) => {
        return (
          s +
          (new Date(c.closed_at!).getTime() - new Date(c.created_at).getTime()) /
            60_000
        );
      }, 0);
      avgOpeningMinutes = Math.round(total / closedCases.length);
    }

    const listoCount = casesThisMonth.filter((c) => c.status === "listo").length;
    const autoCompletionRate =
      totalCasesMonth > 0 ? Math.round((listoCount / totalCasesMonth) * 100) : 0;

    const byStatus: Record<string, number> = {};
    for (const row of byStatusRes.data ?? []) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }

    const byType: Record<string, number> = {};
    for (const row of byTypeRes.data ?? []) {
      byType[row.claim_type] = (byType[row.claim_type] ?? 0) + 1;
    }
    for (const t of ["choque", "robo", "granizo", "incendio"]) {
      if (!(t in byType)) byType[t] = 0;
    }

    const analystCounts: Record<string, { name: string; count: number }> = {};
    for (const row of topAnalystsRes.data ?? []) {
      const id = row.assigned_to as string | null;
      if (!id) continue;
      const name =
        (row.users as { full_name?: string } | null)?.full_name ?? "Analista";
      if (!analystCounts[id]) analystCounts[id] = { name, count: 0 };
      analystCounts[id].count += 1;
    }
    const topAnalysts = Object.values(analystCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((a) => ({ full_name: a.name, closed_count: a.count }));

    return {
      summary: {
        total_cases_month: totalCasesMonth,
        avg_opening_time_minutes: avgOpeningMinutes,
        auto_completion_rate: autoCompletionRate,
        escalated_count: escalatedRes.count ?? 0,
      },
      by_status: byStatus,
      by_type: byType,
      top_analysts: topAnalysts,
      period: { start: monthStart, end: monthEnd },
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    console.error("[metricas] fetch error:", e instanceof Error ? e.name : "unknown");
    return null;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h}h ${m}min`;
}

function formatCurrentMonth(): string {
  const now = new Date();
  return now.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
}

// ── Status bar chart ──────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  listo: "bg-green-500",
  esperando: "bg-yellow-400",
  escalado: "bg-red-400",
  procesando: "bg-blue-400",
  cerrado: "bg-slate-400",
};

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

const TYPE_COLORS: Record<string, string> = {
  choque: "bg-blue-500",
  robo: "bg-purple-500",
  granizo: "bg-cyan-500",
  incendio: "bg-orange-500",
};

// ── Page component ────────────────────────────────────────────────────────────

export default async function MetricasPage() {
  let data: MetricasData | null;

  try {
    data = await fetchMetricas();
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") {
      redirect("/login");
    }
    data = null;
  }

  const hasData =
    data &&
    (data.summary.total_cases_month > 0 ||
      Object.values(data.by_status).some((v) => v > 0));

  const totalByStatus = Object.values(data?.by_status ?? {}).reduce(
    (a, b) => a + b,
    0
  );
  const totalByType = Object.values(data?.by_type ?? {}).reduce(
    (a, b) => a + b,
    0
  );

  return (
    <div className="px-6 py-8 max-w-6xl">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-slate-900">Métricas</h1>
        <p className="mt-1 text-sm text-slate-500">
          KPIs del sistema — {formatCurrentMonth()}
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
          {/* ── Summary cards ────────────────────────────────────────────────── */}
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              label="Total siniestros (mes)"
              value={`${data!.summary.total_cases_month} siniestros`}
              accent="blue"
            />
            <SummaryCard
              label="Tiempo medio de apertura"
              value={formatMinutes(data!.summary.avg_opening_time_minutes)}
              accent="slate"
            />
            <SummaryCard
              label="Tasa de completitud automática"
              value={`${data!.summary.auto_completion_rate}%`}
              accent="green"
            />
            <SummaryCard
              label="Siniestros escalados"
              value={`${data!.summary.escalated_count} siniestros`}
              accent="red"
            />
          </div>

          {/* ── Charts row ───────────────────────────────────────────────────── */}
          <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Cases by status */}
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="mb-4 text-sm font-semibold text-slate-700">
                Siniestros por estado
              </h2>
              {totalByStatus === 0 ? (
                <p className="text-sm text-slate-400">Sin datos.</p>
              ) : (
                <div className="space-y-3">
                  {Object.entries(STATUS_LABELS).map(([key, label]) => {
                    const count = data!.by_status[key] ?? 0;
                    const pct =
                      totalByStatus > 0
                        ? Math.round((count / totalByStatus) * 100)
                        : 0;
                    return (
                      <div key={key}>
                        <div className="mb-1 flex justify-between text-xs text-slate-600">
                          <span>{label}</span>
                          <span>
                            {count} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full rounded-full transition-all ${STATUS_COLORS[key] ?? "bg-slate-400"}`}
                            style={{ width: `${pct}%` }}
                            aria-valuenow={pct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            role="progressbar"
                            aria-label={label}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Cases by type */}
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="mb-4 text-sm font-semibold text-slate-700">
                Siniestros por tipo
              </h2>
              {totalByType === 0 ? (
                <p className="text-sm text-slate-400">Sin datos.</p>
              ) : (
                <div className="space-y-3">
                  {Object.entries(TYPE_LABELS).map(([key, label]) => {
                    const count = data!.by_type[key] ?? 0;
                    const pct =
                      totalByType > 0
                        ? Math.round((count / totalByType) * 100)
                        : 0;
                    return (
                      <div key={key}>
                        <div className="mb-1 flex justify-between text-xs text-slate-600">
                          <span>{label}</span>
                          <span>
                            {count} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full rounded-full transition-all ${TYPE_COLORS[key] ?? "bg-slate-400"}`}
                            style={{ width: `${pct}%` }}
                            aria-valuenow={pct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            role="progressbar"
                            aria-label={label}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ── Top analysts table ───────────────────────────────────────────── */}
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-3">
              <h2 className="text-sm font-semibold text-slate-700">
                Top 5 analistas — casos cerrados este mes
              </h2>
            </div>
            {data!.top_analysts.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-slate-400">
                Ningún caso cerrado este mes.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
                    <th className="px-5 py-3 text-left">#</th>
                    <th className="px-5 py-3 text-left">Analista</th>
                    <th className="px-5 py-3 text-right">Casos cerrados</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.top_analysts.map((analyst, index) => (
                    <tr
                      key={analyst.full_name}
                      className="border-b border-slate-50 last:border-0"
                    >
                      <td className="px-5 py-3 text-slate-400">
                        {index + 1}
                      </td>
                      <td className="px-5 py-3 font-medium text-slate-800">
                        {analyst.full_name}
                      </td>
                      <td className="px-5 py-3 text-right text-slate-700">
                        {analyst.closed_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Summary card sub-component ────────────────────────────────────────────────

type Accent = "blue" | "green" | "red" | "slate";

const ACCENT_CLASSES: Record<Accent, string> = {
  blue: "border-blue-200 bg-blue-50",
  green: "border-green-200 bg-green-50",
  red: "border-red-200 bg-red-50",
  slate: "border-slate-200 bg-slate-50",
};

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: Accent;
}) {
  return (
    <div
      className={`rounded-lg border p-5 ${ACCENT_CLASSES[accent]}`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
    </div>
  );
}
