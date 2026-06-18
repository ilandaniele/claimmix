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

import { and, eq, gte, lt } from "drizzle-orm";
import { requireRole, ALL_ROLES } from "@/lib/auth/require-role";
import { cases, users } from "@/lib/db/schema";
import { ok, err } from "@/lib/api/respond";

export async function GET() {
  try {
    const { db, userRow } = await requireRole(...ALL_ROLES);
    const tenantId = userRow.tenant_id;

    // ── Date window: current calendar month ──────────────────────────────────
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    // ── Parallel queries (all explicitly tenant-scoped) ──────────────────────
    const [casesThisMonth, byStatusRows, byTypeRows, escalatedCount, topAnalystRows] =
      await Promise.all([
        // Total cases created this month
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
              eq(cases.tenant_id, tenantId),
              gte(cases.created_at, monthStart),
              lt(cases.created_at, monthEnd)
            )
          ),

        // Cases by status (all time — to show distribution)
        db
          .select({ status: cases.status })
          .from(cases)
          .where(eq(cases.tenant_id, tenantId)),

        // Cases by type (all time)
        db
          .select({ claim_type: cases.claim_type })
          .from(cases)
          .where(eq(cases.tenant_id, tenantId)),

        // Escalated this month
        db.$count(
          cases,
          and(
            eq(cases.tenant_id, tenantId),
            eq(cases.status, "escalado"),
            gte(cases.created_at, monthStart),
            lt(cases.created_at, monthEnd)
          )
        ),

        // Top 5 analysts by cases closed this month
        db
          .select({ assigned_to: cases.assigned_to, full_name: users.full_name })
          .from(cases)
          .leftJoin(users, eq(users.id, cases.assigned_to))
          .where(
            and(
              eq(cases.tenant_id, tenantId),
              eq(cases.status, "cerrado"),
              gte(cases.closed_at, monthStart),
              lt(cases.closed_at, monthEnd)
            )
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
    for (const t of ["choque", "robo", "granizo", "incendio"]) {
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
      period: {
        start: monthStart,
        end: monthEnd,
      },
    });
  } catch (e) {
    return err(e);
  }
}
