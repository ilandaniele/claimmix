/**
 * Análisis page — W7 supplemental pages.
 *
 * Shows aggregated statistics about cases across time periods.
 * Server Component — fetches data directly from Drizzle.
 * Explicit tenant_id filter on every query (RLS removed).
 */

import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { eq, and, gte, count } from "drizzle-orm";
import { cases, users } from "@/lib/db/schema";
import { statusOptions, claimTypeOptions } from "@/lib/labels/case-catalog";
import { AppError } from "@/lib/errors";
import { redirect, unstable_rethrow } from "next/navigation";
import { connection } from "next/server";

// ── Status and type labels ─────────────────────────────────────────────────────

/*
 * Los estados y los tipos salen del esquema, no de una copia acá.
 *
 * Estaban escritos a mano con cinco estados de trece y cuatro tipos de nueve:
 * esta pantalla no listaba cristales, responsabilidad civil, robo de contenido
 * ni accidente personal, así que sus casos no aparecían en la distribución por
 * más que existieran. Ocho estados corrían la misma suerte.
 *
 * De paso los rótulos pasan de plural a singular ("Listos" → "Listo"), que es
 * como los tiene el diccionario y como se ven en el resto del producto.
 */
const STATUS_OPCIONES = statusOptions();
const TIPO_OPCIONES = claimTypeOptions();

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

    const now = new Date();
    const day7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const day30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [allCasesRows, [recent7Row], [recent30Row]] = await Promise.all([
      enTenant(tenantCtx, (db) =>
        db
          .select({ status: cases.status, claim_type: cases.claim_type, confidence_min: cases.confidence_min })
          .from(cases)
          
      ),
      enTenant(tenantCtx, (db) =>
        db
          .select({ n: count() })
          .from(cases)
          .where(and( gte(cases.created_at, day7)))
      ),
      enTenant(tenantCtx, (db) =>
        db
          .select({ n: count() })
          .from(cases)
          .where(and( gte(cases.created_at, day30)))
      ),
    ]);

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let confSum = 0;
    let confCount = 0;

    for (const c of allCasesRows) {
      byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
      if (c.claim_type) byType[c.claim_type] = (byType[c.claim_type] ?? 0) + 1;
      if (c.confidence_min !== null) {
        confSum += parseFloat(String(c.confidence_min));
        confCount++;
      }
    }

    return {
      total: allCasesRows.length,
      by_status: byStatus,
      by_type: byType,
      avg_confidence: confCount > 0 ? Math.round((confSum / confCount) * 100) / 100 : null,
      recent_7_days: recent7Row?.n ?? 0,
      recent_30_days: recent30Row?.n ?? 0,
    };
  } catch (e) {
    unstable_rethrow(e);
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
                {TIPO_OPCIONES.map(({ value: key, label }) => (
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
                {STATUS_OPCIONES.map(({ value: key, label }) => (
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
