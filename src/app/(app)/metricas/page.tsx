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

import { getSessionContext } from "@/lib/auth/session";
import { formatUsd as formatUsdShared } from "@/lib/utils";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { eq, and, gte, lt, count, sql, isNotNull } from "drizzle-orm";
import { aiUsage, authUsers, cases, users } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { redirect, unstable_rethrow } from "next/navigation";
import { connection } from "next/server";

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
  ai_usage: {
    month: AiUsageSummary;
    all_time: AiUsageSummary;
    by_user: AiUsageByUser[];
    by_model: AiUsageByModel[];
  };
  period: { start: string; end: string };
}

interface AiUsageSummary {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

interface AiUsageByUser extends AiUsageSummary {
  user_id: string | null;
  full_name: string;
  email: string;
}

interface AiUsageByModel extends AiUsageSummary {
  model: string;
}

function normalizeUsage(row?: {
  calls?: number | string | null;
  prompt_tokens?: number | string | null;
  completion_tokens?: number | string | null;
  cost_usd?: number | string | null;
}): AiUsageSummary {
  const promptTokens = Number(row?.prompt_tokens ?? 0);
  const completionTokens = Number(row?.completion_tokens ?? 0);
  return {
    calls: Number(row?.calls ?? 0),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cost_usd: Number(row?.cost_usd ?? 0),
  };
}

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
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    if (!userRow) return null;

    // ── Date window ────────────────────────────────────────────────────────────
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    const [
      [resumenMes],
      byStatusRows,
      byTypeRows,
      [escalatedRow],
      topAnalystsRows,
      [usageMonthRow],
      [usageAllTimeRow],
      usageByUserRows,
      usageByModelRows,
    ] = await Promise.all([
        /*
         * Los tres números del mes en una fila, en vez de traer los casos.
         *
         * Esto devolvía una fila por caso del mes —455 en producción— para
         * contarlas en JS. La suma y el promedio los sabe hacer la base, y lo
         * que viaja pasa de cientos de filas a una.
         *
         * `sum` y `count` por separado y la división en JS a propósito: así el
         * redondeo es exactamente el mismo `Math.round(total / n)` de antes, y
         * el número que ve la pantalla no se mueve.
         */
        enTenant(tenantCtx, (db) =>
          db
            .select({
              total: sql<number>`count(*)::int`,
              listo: sql<number>`count(*) filter (where ${cases.status} = 'listo')::int`,
              cerrados: sql<number>`count(*) filter (where ${cases.status} = 'cerrado' and ${cases.closed_at} is not null)::int`,
              minutos: sql<number>`coalesce(sum(extract(epoch from (${cases.closed_at} - ${cases.created_at})) / 60) filter (where ${cases.status} = 'cerrado' and ${cases.closed_at} is not null), 0)::float8`,
            })
            .from(cases)
            .where(and(
              gte(cases.created_at, monthStart),
              lt(cases.created_at, monthEnd),
            ))
        ),
        // Agrupado en la base: traía las 458 filas de `cases` para contarlas.
        enTenant(tenantCtx, (db) =>
          db
            .select({ status: cases.status, n: sql<number>`count(*)::int` })
            .from(cases)
            .groupBy(cases.status)
        ),
        // Idem, y el `is not null` reemplaza al `if (row.claim_type)` que
        // descartaba esas filas después de haberlas traído.
        enTenant(tenantCtx, (db) =>
          db
            .select({ claim_type: cases.claim_type, n: sql<number>`count(*)::int` })
            .from(cases)
            .where(isNotNull(cases.claim_type))
            .groupBy(cases.claim_type)
        ),
        enTenant(tenantCtx, (db) =>
          db
            .select({ n: count() })
            .from(cases)
            .where(and(
              eq(cases.status, "escalado"),
              gte(cases.created_at, monthStart),
              lt(cases.created_at, monthEnd),
            ))
        ),
        /*
         * Los cinco de arriba, contados y ordenados por la base.
         *
         * El desempate por nombre es nuevo y deliberado: el `.sort()` de JS es
         * estable sobre el orden en que llegaron las filas, y un `order by`
         * sin criterio secundario no. Sin esto, dos analistas con la misma
         * cantidad podían intercambiarse entre dos cargas de la pantalla.
         */
        enTenant(tenantCtx, (db) =>
          db
            .select({
              assigned_to: cases.assigned_to,
              full_name: users.full_name,
              n: sql<number>`count(*)::int`,
            })
            .from(cases)
            .leftJoin(users, eq(cases.assigned_to, users.id))
            .where(and(
              eq(cases.status, "cerrado"),
              gte(cases.closed_at, monthStart),
              lt(cases.closed_at, monthEnd),
              isNotNull(cases.assigned_to),
            ))
            .groupBy(cases.assigned_to, users.full_name)
            .orderBy(sql`count(*) desc, ${users.full_name} asc`)
            .limit(5)
        ),
        enTenant(tenantCtx, (db) =>
          db
            .select({
              calls: count(),
              prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::float8`,
              completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::float8`,
              cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
            })
            .from(aiUsage)
            .where(and(
              gte(aiUsage.created_at, monthStart),
              lt(aiUsage.created_at, monthEnd),
            ))
        ),
        enTenant(tenantCtx, (db) =>
          db
            .select({
              calls: count(),
              prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::float8`,
              completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::float8`,
              cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
            })
            .from(aiUsage)
            
        ),
        enTenant(tenantCtx, (db) =>
          db
            .select({
              user_id: aiUsage.user_id,
              full_name: users.full_name,
              email: authUsers.email,
              calls: count(),
              prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::float8`,
              completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::float8`,
              cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
            })
            .from(aiUsage)
            .leftJoin(users, eq(users.id, aiUsage.user_id))
            .leftJoin(authUsers, eq(authUsers.id, aiUsage.user_id))
            .where(and(
              gte(aiUsage.created_at, monthStart),
              lt(aiUsage.created_at, monthEnd),
            ))
            .groupBy(aiUsage.user_id, users.full_name, authUsers.email)
        ),
        enTenant(tenantCtx, (db) =>
          db
            .select({
              model: aiUsage.model,
              calls: count(),
              prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::float8`,
              completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::float8`,
              cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
            })
            .from(aiUsage)
            .where(and(
              gte(aiUsage.created_at, monthStart),
              lt(aiUsage.created_at, monthEnd),
            ))
            .groupBy(aiUsage.model)
        ),
      ]);

    const totalCasesMonth = resumenMes?.total ?? 0;

    // El mismo Math.round(total / n) de antes, con la suma hecha por la base.
    const avgOpeningMinutes: number | null =
      resumenMes && resumenMes.cerrados > 0
        ? Math.round(resumenMes.minutos / resumenMes.cerrados)
        : null;

    const listoCount = resumenMes?.listo ?? 0;
    const autoCompletionRate =
      totalCasesMonth > 0 ? Math.round((listoCount / totalCasesMonth) * 100) : 0;

    const byStatus: Record<string, number> = {};
    for (const row of byStatusRows) byStatus[row.status] = row.n;

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      if (row.claim_type) byType[row.claim_type] = row.n;
    }
    for (const t of ["choque", "robo", "granizo", "incendio"]) {
      if (!(t in byType)) byType[t] = 0;
    }

    const topAnalysts = topAnalystsRows.map((row) => ({
      full_name: row.full_name ?? "Analista",
      closed_count: row.n,
    }));

    const usageByUser: AiUsageByUser[] = usageByUserRows
      .map((row) => ({
        user_id: row.user_id,
        full_name: row.full_name ?? "Sistema",
        email: row.email ?? (row.user_id ? "" : "Procesos automáticos"),
        ...normalizeUsage(row),
      }))
      .sort((a, b) => b.total_tokens - a.total_tokens)
      .slice(0, 8);

    const usageByModel: AiUsageByModel[] = usageByModelRows
      .map((row) => ({
        model: row.model,
        ...normalizeUsage(row),
      }))
      .sort((a, b) => b.total_tokens - a.total_tokens);

    return {
      summary: {
        total_cases_month: totalCasesMonth,
        avg_opening_time_minutes: avgOpeningMinutes,
        auto_completion_rate: autoCompletionRate,
        escalated_count: escalatedRow?.n ?? 0,
      },
      by_status: byStatus,
      by_type: byType,
      top_analysts: topAnalysts,
      ai_usage: {
        month: normalizeUsage(usageMonthRow),
        all_time: normalizeUsage(usageAllTimeRow),
        by_user: usageByUser,
        by_model: usageByModel,
      },
      period: { start: monthStart, end: monthEnd },
    };
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

function formatCurrentMonth(): string {
  const now = new Date();
  return now.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
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
