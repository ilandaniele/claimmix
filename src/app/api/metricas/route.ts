/**
 * GET /api/metricas
 *
 * Returns aggregated KPI metrics for the Métricas page (AC16 supplemental pages).
 * All numbers are computed from real data in the `cases` and `ai_usage` tables.
 * Scoped to the authenticated user's tenant via RLS.
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

import { createServerClient } from "@/lib/supabase/server";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

export async function GET() {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (!user || authErr) throw new AppError("MISSING_SESSION");

    // ── Date window: current calendar month ──────────────────────────────────
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    // ── Parallel queries ──────────────────────────────────────────────────────
    const [casesMonthResult, byStatusResult, byTypeResult, escalatedResult, topAnalystsResult] =
      await Promise.all([
        // Total cases created this month
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("cases")
          .select("id, status, created_at, closed_at, confidence_min", {
            count: "exact",
          })
          .gte("created_at", monthStart)
          .lt("created_at", monthEnd),

        // Cases by status (all time — to show distribution)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("cases")
          .select("status"),

        // Cases by type (all time)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("cases")
          .select("claim_type"),

        // Escalated this month
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("cases")
          .select("id", { count: "exact" })
          .eq("status", "escalado")
          .gte("created_at", monthStart)
          .lt("created_at", monthEnd),

        // Top 5 analysts by cases closed this month
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("cases")
          .select("assigned_to, users!cases_assigned_to_fkey(full_name)")
          .eq("status", "cerrado")
          .gte("closed_at", monthStart)
          .lt("closed_at", monthEnd),
      ]);

    // ── Summary: total cases this month ──────────────────────────────────────
    const casesThisMonth: Array<{
      id: string;
      status: string;
      created_at: string;
      closed_at: string | null;
      confidence_min: number | null;
    }> = casesMonthResult.data ?? [];

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

    // ── Escalated count this month ────────────────────────────────────────────
    const escalatedCount: number = escalatedResult.count ?? 0;

    // ── By status (all time) ──────────────────────────────────────────────────
    const byStatus: Record<string, number> = {};
    for (const row of byStatusResult.data ?? []) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }

    // ── By type (all time) ───────────────────────────────────────────────────
    const byType: Record<string, number> = {};
    for (const row of byTypeResult.data ?? []) {
      byType[row.claim_type] = (byType[row.claim_type] ?? 0) + 1;
    }
    // Ensure all 4 types are present even with 0 counts
    for (const t of ["choque", "robo", "granizo", "incendio"]) {
      if (!(t in byType)) byType[t] = 0;
    }

    // ── Top 5 analysts by closed cases this month ─────────────────────────────
    const analystCounts: Record<string, { name: string; count: number }> = {};
    for (const row of topAnalystsResult.data ?? []) {
      const id = row.assigned_to as string | null;
      if (!id) continue;
      const name =
        (row.users as { full_name?: string } | null)?.full_name ?? "Analista";
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
