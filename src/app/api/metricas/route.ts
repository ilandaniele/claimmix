/**
 * GET /api/metricas
 *
 * Returns aggregated KPI metrics for the Métricas page (AC16 supplemental pages).
 * All numbers are computed from real data in the `cases` and `ai_usage` tables.
 * Scoped to the authenticated user's tenant via an explicit tenant_id filter.
 *
 * Response shape:
 * {
 *   summary: {
 *     total_cases_month: number,
 *     avg_opening_time_minutes: number | null,
 *     auto_completion_rate: number,
 *     escalated_count: number
 *   },
 *   by_status: Record<string, number>,
 *   by_type: Record<string, number>,
 *   top_analysts: Array<{ full_name: string; closed_count: number }>
 * }
 */

import { and, eq, gte, lt, count, sql } from "drizzle-orm";
import { ClaimTypeSchema } from "@/lib/schemas/cases";
import { requireRole, ALL_ROLES } from "@/lib/auth/require-role";
import { aiUsage, authUsers, cases, users } from "@/lib/db/schema";
import { ok, err } from "@/lib/api/respond";
import { countRows } from "@/lib/db/helpers";
import { enTenant, type TenantContext } from "@/data/scope";

function normalizeUsage(row?: {
  calls?: number | string | null;
  prompt_tokens?: number | string | null;
  completion_tokens?: number | string | null;
  cost_usd?: number | string | null;
}) {
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

export async function GET() {
  try {
    const { userRow } = await requireRole(...ALL_ROLES);
    const tenantId = userRow.tenant_id;
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId };

    // ── Date window: current calendar month ──────────────────────────────────
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    // ── Parallel queries (all explicitly tenant-scoped) ──────────────────────
    const [
      casesThisMonth,
      byStatusRows,
      byTypeRows,
      escalatedCount,
      topAnalystRows,
      [usageMonthRow],
      [usageAllTimeRow],
      usageByUserRows,
      usageByModelRows,
    ] = await Promise.all([
        // Total cases created this month
        enTenant(tenantCtx, (db) =>
          db
            .select({
              id: cases.id,
              status: cases.status,
              created_at: cases.created_at,
              closed_at: cases.closed_at,
              confidence_min: cases.confidence_min,
            })
            .from(cases)
            .where(
              and(
                gte(cases.created_at, monthStart),
                lt(cases.created_at, monthEnd)
              )
            )
        ),

        // Cases by status (all time — to show distribution)
        enTenant(tenantCtx, (db) =>
          db
            .select({ status: cases.status })
            .from(cases)
            
        ),

        // Cases by type (all time)
        enTenant(tenantCtx, (db) =>
          db
            .select({ claim_type: cases.claim_type })
            .from(cases)
            
        ),

        // Escalated this month
        //
        // Por `countRows` y no por `db.$count` adentro de `enTenant`: eso ultimo
        // no devuelve una consulta sino un objeto que se puede esperar, y la capa
        // manda todo por `batch()`, que necesita armarla. Reventaba con
        // "query._prepare is not a function" cada vez que alguien abria metricas.
        countRows(
          tenantCtx,
          cases,
          and(
            eq(cases.tenant_id, tenantId),
            eq(cases.status, "escalado"),
            gte(cases.created_at, monthStart),
            lt(cases.created_at, monthEnd)
          )
        ),

        // Top 5 analysts by cases closed this month
        enTenant(tenantCtx, (db) =>
          db
            .select({ assigned_to: cases.assigned_to, full_name: users.full_name })
            .from(cases)
            .leftJoin(users, eq(users.id, cases.assigned_to))
            .where(
              and(
                eq(cases.status, "cerrado"),
                gte(cases.closed_at, monthStart),
                lt(cases.closed_at, monthEnd)
              )
            )
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
            .where(
              and(
                gte(aiUsage.created_at, monthStart),
                lt(aiUsage.created_at, monthEnd)
              )
            )
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
            .where(
              and(
                gte(aiUsage.created_at, monthStart),
                lt(aiUsage.created_at, monthEnd)
              )
            )
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
            .where(
              and(
                gte(aiUsage.created_at, monthStart),
                lt(aiUsage.created_at, monthEnd)
              )
            )
            .groupBy(aiUsage.model)
        ),
      ]);

    // ── Summary: total cases this month ──────────────────────────────────────
    const totalCasesMonth = casesThisMonth.length;

    // ── Average opening time (created → closed, for cerrado cases this month) ─
    const closedCases = casesThisMonth.filter(
      (c) => c.status === "cerrado" && c.closed_at
    );
    let avgOpeningMinutes: number | null = null;
    if (closedCases.length > 0) {
      const totalMinutes = closedCases.reduce((sum, c) => {
        const created = new Date(c.created_at).getTime();
        const closed = new Date(c.closed_at!).getTime();
        return sum + (closed - created) / 60_000;
      }, 0);
      avgOpeningMinutes = Math.round(totalMinutes / closedCases.length);
    }

    // ── Auto-completion rate: listo cases / total (where not escalado) ────────
    const listoCount = casesThisMonth.filter((c) => c.status === "listo").length;
    const autoCompletionRate =
      totalCasesMonth > 0 ? Math.round((listoCount / totalCasesMonth) * 100) : 0;

    // ── By status (all time) ──────────────────────────────────────────────────
    const byStatus: Record<string, number> = {};
    for (const row of byStatusRows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }

    // ── By type (all time) ───────────────────────────────────────────────────
    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      // NULL claim_type buckets under the "null" key — matches the previous
      // Neon-js behaviour where obj[null] coerces to obj["null"].
      const key = row.claim_type ?? "null";
      byType[key] = (byType[key] ?? 0) + 1;
    }
    // Ensure all 4 types are present even with 0 counts
    // Los nueve tipos del esquema, no los cuatro de cuando esto se escribió.
    // Sembrar sólo cuatro dejaba a cristales, RC, robo de contenido,
    // accidente personal y `other` fuera del gráfico salvo que hubiera casos,
    // así que la distribución se leía como si esos tipos no existieran.
    for (const t of ClaimTypeSchema.options) {
      if (!(t in byType)) byType[t] = 0;
    }

    // ── Top 5 analysts by closed cases this month ─────────────────────────────
    const analystCounts: Record<string, { name: string; count: number }> = {};
    for (const row of topAnalystRows) {
      const id = row.assigned_to;
      if (!id) continue;
      const name = row.full_name ?? "Analista";
      if (!analystCounts[id]) {
        analystCounts[id] = { name, count: 0 };
      }
      analystCounts[id].count += 1;
    }

    const topAnalysts = Object.values(analystCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((a) => ({ full_name: a.name, closed_count: a.count }));

    const usageByUser = usageByUserRows
      .map((row) => ({
        user_id: row.user_id,
        full_name: row.full_name ?? "Sistema",
        email: row.email ?? (row.user_id ? "" : "Procesos automáticos"),
        ...normalizeUsage(row),
      }))
      .sort((a, b) => b.total_tokens - a.total_tokens)
      .slice(0, 8);

    const usageByModel = usageByModelRows
      .map((row) => ({
        model: row.model,
        ...normalizeUsage(row),
      }))
      .sort((a, b) => b.total_tokens - a.total_tokens);

    return ok({
      summary: {
        total_cases_month: totalCasesMonth,
        avg_opening_time_minutes: avgOpeningMinutes,
        auto_completion_rate: autoCompletionRate,
        escalated_count: escalatedCount,
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
      period: {
        start: monthStart,
        end: monthEnd,
      },
    });
  } catch (e) {
    return err(e);
  }
}
