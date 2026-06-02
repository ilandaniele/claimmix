/**
 * AI budget guard — enforces monthly cost ceiling and daily per-user/tenant caps.
 *
 * LLM10: Monthly $200 project cap enforced in code. Fail closed when exceeded.
 * Spec:
 *   - Per-user: 100k tokens/day (AI_USER_DAILY_TOKEN_CAP env)
 *   - Per-tenant: 5M tokens/day (AI_TENANT_DAILY_TOKEN_CAP env)
 *   - Monthly project cap: $200 (MONTHLY_BUDGET_USD env, default 200)
 *
 * AC10 (budget guard): Returns { exceeded: true, reason } when any cap is hit.
 *
 * Uses service-role client to query ai_usage table (no RLS bypass concern
 * here — this is a server-only, privileged cost check).
 *
 * Token cost model for gpt-4o-mini (as of 2024):
 *   Input:  $0.150 per 1M tokens = $0.00000015 per token
 *   Output: $0.600 per 1M tokens = $0.00000060 per token
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

/** Cost per token for gpt-4o-mini (USD). */
export const COST_PER_PROMPT_TOKEN = 0.00000015;
export const COST_PER_COMPLETION_TOKEN = 0.00000060;

/**
 * Compute estimated cost for a given token usage.
 */
export function computeCostUsd(promptTokens: number, completionTokens: number): number {
  return (
    promptTokens * COST_PER_PROMPT_TOKEN +
    completionTokens * COST_PER_COMPLETION_TOKEN
  );
}

export interface BudgetCheckResult {
  /** True if any cap (monthly or daily) has been exceeded. */
  exceeded: boolean;
  reason?: string;
}

/**
 * Check if AI budget is available for the current tenant.
 *
 * Checks:
 *   1. Monthly project-level cost cap ($200 by default)
 *   2. Per-tenant daily token cap
 *   3. Per-user daily token cap (if userId provided)
 *
 * @param tenantId - Tenant whose budget to check.
 * @param userId   - Optional user ID for per-user cap.
 */
export async function checkBudget(
  tenantId: string,
  userId?: string | null
): Promise<BudgetCheckResult> {
  const supabase = createServiceClient();

  const monthlyCapUsd = parseFloat(process.env.MONTHLY_BUDGET_USD ?? "200");
  const tenantDailyTokenCap = parseInt(
    process.env.AI_TENANT_DAILY_TOKEN_CAP ?? "5000000",
    10
  );
  const userDailyTokenCap = parseInt(
    process.env.AI_USER_DAILY_TOKEN_CAP ?? "100000",
    10
  );

  // ── 1. Monthly cost check (project-wide) ─────────────────────────────────────
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: monthlyData, error: monthlyError } = await (supabase as any)
    .from("ai_usage")
    .select("cost_usd")
    .gte("created_at", monthStart.toISOString());

  if (monthlyError) {
    // Fail open on DB error (don't block users due to budget check failure).
    console.error("[budget] Monthly check error:", monthlyError.code);
    return { exceeded: false };
  }

  const monthlyCostUsd = (monthlyData ?? []).reduce(
    (sum: number, row: Record<string, unknown>) => sum + ((row.cost_usd as number) ?? 0),
    0
  );

  if (monthlyCostUsd >= monthlyCapUsd) {
    return {
      exceeded: true,
      reason: `Presupuesto mensual de IA agotado ($${monthlyCostUsd.toFixed(2)} / $${monthlyCapUsd}).`,
    };
  }

  // ── 2. Tenant daily token cap ─────────────────────────────────────────────────
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: tenantDayData, error: tenantDayError } = await (supabase as any)
    .from("ai_usage")
    .select("prompt_tokens,completion_tokens")
    .eq("tenant_id", tenantId)
    .gte("created_at", dayStart.toISOString());

  if (tenantDayError) {
    console.error("[budget] Tenant daily check error:", tenantDayError.code);
    return { exceeded: false };
  }

  const tenantDayTokens = (tenantDayData ?? []).reduce(
    (sum: number, row: Record<string, unknown>) =>
      sum + ((row.prompt_tokens as number) ?? 0) + ((row.completion_tokens as number) ?? 0),
    0
  );

  if (tenantDayTokens >= tenantDailyTokenCap) {
    return {
      exceeded: true,
      reason: `Presupuesto diario de tokens agotado para el tenant (${tenantDayTokens.toLocaleString()} / ${tenantDailyTokenCap.toLocaleString()}).`,
    };
  }

  // ── 3. Per-user daily token cap ───────────────────────────────────────────────
  if (userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: userDayData, error: userDayError } = await (supabase as any)
      .from("ai_usage")
      .select("prompt_tokens,completion_tokens")
      .eq("user_id", userId)
      .gte("created_at", dayStart.toISOString());

    if (userDayError) {
      console.error("[budget] User daily check error:", userDayError.code);
      return { exceeded: false };
    }

    const userDayTokens = (userDayData ?? []).reduce(
      (sum: number, row: Record<string, unknown>) =>
        sum + ((row.prompt_tokens as number) ?? 0) + ((row.completion_tokens as number) ?? 0),
      0
    );

    if (userDayTokens >= userDailyTokenCap) {
      return {
        exceeded: true,
        reason: `Presupuesto diario de tokens agotado para el usuario (${userDayTokens.toLocaleString()} / ${userDailyTokenCap.toLocaleString()}).`,
      };
    }
  }

  return { exceeded: false };
}

/**
 * Record AI usage after a successful extraction.
 * Does NOT throw — usage recording failure is non-fatal.
 *
 * @param tenantId         - Tenant ID.
 * @param userId           - User who triggered the extraction (nullable for system events).
 * @param model            - Model used (e.g. "gpt-4o-mini").
 * @param promptTokens     - Prompt token count.
 * @param completionTokens - Completion token count.
 * @param costUsd          - Computed cost in USD.
 */
export async function recordUsage(
  tenantId: string,
  userId: string | null,
  model: string,
  promptTokens: number,
  completionTokens: number,
  costUsd: number
): Promise<void> {
  try {
    const supabase = createServiceClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("ai_usage").insert({
      tenant_id: tenantId,
      user_id: userId,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost_usd: parseFloat(costUsd.toFixed(4)),
    });
    if (error) {
      console.error("[budget] Failed to record AI usage:", error.code);
    }
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error("[budget] Exception recording AI usage:", name);
  }
}
