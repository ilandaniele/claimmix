/**
 * Métricas page — AC16 supplemental pages (W7).
 *
 * Server Component that fetches KPI data and renders:
 *   - 4 summary cards
 *   - Cases by status (visual bar chart — HTML/CSS only, no chart library)
 *   - Cases by type (donut-style percentage bars)
 *   - Top 5 analysts table
 *
 * All numbers in Spanish (es-AR). Empty state shown when no data exists.
 */

import { nombreDelMesArgentino } from "@/core/fecha/dia-argentino";
import { getSessionContext } from "@/lib/auth/session";
import { formatUsd as formatUsdShared } from "@/lib/utils";
import {
  getTenantKpis,
  type MetricasData,
  type AiUsageByUser,
  type AiUsageByModel,
} from "@/server/metrics/kpis";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { eq, and, gte, lt, count, sql, isNotNull } from "drizzle-orm";
import { aiUsage, authUsers, cases, users } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { redirect, unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { anchoDeBarra } from "@/lib/ui/ancho-de-barra";

/*
 * Los números salen de `getTenantKpis`, que también usa /api/metricas.
 *
 * Estaban escritos acá y otra vez en la ruta, con las mismas nueve consultas
 * y la misma agregación, y las dos copias ya habían divergido en cómo tratan
 * un `claim_type` nulo.
 *
 * Lo que queda acá es lo que de verdad es de la pantalla: resolver quién está
 * mirando, y dibujar.
 */
async function fetchMetricas(): Promise<MetricasData | null> {
  try {
    await connection();
    const session = await getSessionContext();
    if (!session?.user) return null;

    // sin-inquilino: Ésta es la consulta que AVERIGUA de qué inquilino es la sesión.
    // No puede pasar por una capa que necesita el dato que ella busca.
    const [userRow] = await db
      .select({ tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    // El chequeo va ANTES de leerle un campo: estaba al revés, así que una
    // sesión sin perfil reventaba en la línea de abajo en vez de devolver null.
    if (!userRow) return null;

    return await getTenantKpis({ tenantId: userRow.tenant_id });
  } catch (e) {
    unstable_rethrow(e);
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

// El encabezado nombra el mismo mes que la ventana de `kpis.ts`, y por lo tanto
// también tiene que decir la zona. Sin ella, en Vercel la última noche de agosto
// el título dice «septiembre» sobre datos de agosto.
function formatCurrentMonth(): string {
  return nombreDelMesArgentino();
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("es-AR").format(Math.round(value));
}

// El costo de IA por llamada es de milésimas: con dos decimales todo se ve
// $0,01. De ahí el 4.
const formatUsd = (value: number) => formatUsdShared(value, 4);

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
      Object.values(data.by_status).some((v) => v > 0) ||
      data.ai_usage.all_time.total_tokens > 0);

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
          <section className="mb-8">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Uso de IA
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Tokens consumidos y costo estimado del tenant.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <UsageStat
                label="Tokens este mes"
                value={formatNumber(data!.ai_usage.month.total_tokens)}
                helper={`${formatNumber(data!.ai_usage.month.prompt_tokens)} prompt / ${formatNumber(data!.ai_usage.month.completion_tokens)} respuesta`}
              />
              <UsageStat
                label="Costo este mes"
                value={formatUsd(data!.ai_usage.month.cost_usd)}
                helper={`${formatNumber(data!.ai_usage.month.calls)} ejecuciones`}
              />
              <UsageStat
                label="Tokens históricos"
                value={formatNumber(data!.ai_usage.all_time.total_tokens)}
                helper={`${formatNumber(data!.ai_usage.all_time.prompt_tokens)} prompt / ${formatNumber(data!.ai_usage.all_time.completion_tokens)} respuesta`}
              />
              <UsageStat
                label="Costo histórico"
                value={formatUsd(data!.ai_usage.all_time.cost_usd)}
                helper={`${formatNumber(data!.ai_usage.all_time.calls)} ejecuciones`}
              />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/70">
                <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-100">
                    Tokens por usuario este mes
                  </h3>
                </div>
                {data!.ai_usage.by_user.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-slate-400">
                    Sin consumo de IA este mes.
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400">
                        <th className="px-5 py-3 text-left">Usuario</th>
                        <th className="px-5 py-3 text-right">Tokens</th>
                        <th className="px-5 py-3 text-right">Costo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.ai_usage.by_user.map((row) => (
                        <tr
                          key={row.user_id ?? "system"}
                          className="border-b border-slate-50 last:border-0 dark:border-slate-800"
                        >
                          <td className="px-5 py-3">
                            <div className="font-medium text-slate-800 dark:text-slate-100">
                              {row.full_name}
                            </div>
                            {row.email && (
                              <div className="text-xs text-slate-500 dark:text-slate-400">
                                {row.email}
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-3 text-right text-slate-700 dark:text-slate-200">
                            {formatNumber(row.total_tokens)}
                            <div className="text-xs text-slate-400">
                              {formatNumber(row.calls)} ejec.
                            </div>
                          </td>
                          <td className="px-5 py-3 text-right text-slate-700 dark:text-slate-200">
                            {formatUsd(row.cost_usd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/70">
                <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-100">
                    Tokens por modelo este mes
                  </h3>
                </div>
                {data!.ai_usage.by_model.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-slate-400">
                    Sin consumo de IA este mes.
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400">
                        <th className="px-5 py-3 text-left">Modelo</th>
                        <th className="px-5 py-3 text-right">Tokens</th>
                        <th className="px-5 py-3 text-right">Costo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.ai_usage.by_model.map((row) => (
                        <tr
                          key={row.model}
                          className="border-b border-slate-50 last:border-0 dark:border-slate-800"
                        >
                          <td className="px-5 py-3 font-mono text-xs text-slate-700 dark:text-slate-200">
                            {row.model}
                          </td>
                          <td className="px-5 py-3 text-right text-slate-700 dark:text-slate-200">
                            {formatNumber(row.total_tokens)}
                            <div className="text-xs text-slate-400">
                              {formatNumber(row.calls)} ejec.
                            </div>
                          </td>
                          <td className="px-5 py-3 text-right text-slate-700 dark:text-slate-200">
                            {formatUsd(row.cost_usd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>

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
                            className={`h-full rounded-full transition-all ${STATUS_COLORS[key] ?? "bg-slate-400"} ${anchoDeBarra(pct)}`}
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
                            className={`h-full rounded-full transition-all ${TYPE_COLORS[key] ?? "bg-slate-400"} ${anchoDeBarra(pct)}`}
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

function UsageStat({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/70">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-slate-100">
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{helper}</p>
    </div>
  );
}
