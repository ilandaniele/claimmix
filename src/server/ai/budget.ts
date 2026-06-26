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
 * Token cost model (as of 2024):
 *   gpt-4o-mini — Input: $0.150/1M, Output: $0.600/1M
 *   gpt-4o      — Input: $2.500/1M, Output: $10.00/1M
 */

import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { db, tables } from "@/lib/db";

/** @deprecated Legacy constants for gpt-4o-mini. Use computeCostUsd(tokens, tokens, model). */
export const COST_PER_PROMPT_TOKEN = 0.00000015;
export const COST_PER_COMPLETION_TOKEN = 0.00000060;

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.00000015, output: 0.00000060 },
  "gpt-4o":      { input: 0.0000025,  output: 0.00001 },
};

/**
 * Compute estimated cost for a given token usage.
 * Pass model to get accurate per-model pricing; defaults to gpt-4o-mini rates.
 */
export function computeCostUsd(promptTokens: number, completionTokens: number, model?: string): number {
  const rates = MODEL_COSTS[model ?? "gpt-4o-mini"] ?? MODEL_COSTS["gpt-4o-mini"]!;
  return promptTokens * rates.input + completionTokens * rates.output;
}

/**
 * Estimate the cost of a Vertex AI supervised fine-tuning job for Gemini Flash.
 * Formula: examples × avg_tokens/example × default_epochs / 1000 × price/1K tokens.
 * Assumptions: 1000 tokens/example, 3 epochs, $0.008/1K training tokens.
 */
export function estimateVertexTuningCostUsd(exampleCount: number): number {
  const AVG_TOKENS_PER_EXAMPLE = 1000;
  const DEFAULT_EPOCHS = 3;
  const PRICE_PER_1K_TOKENS = 0.008;
  const totalTokens = exampleCount * AVG_TOKENS_PER_EXAMPLE * DEFAULT_EPOCHS;
  return (totalTokens / 1000) * PRICE_PER_1K_TOKENS;
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

  let monthlyCostUsd = 0;
  try {
    const [monthly] = await db
      .select({
        total: sql<number>`coalesce(sum(${tables.aiUsage.cost_usd}), 0)::float8`,
      })
      .from(tables.aiUsage)
      .where(gte(tables.aiUsage.created_at, monthStart.toISOString()));
    monthlyCostUsd = monthly?.total ?? 0;
  } catch (e) {
    // Fail open on DB error (don't block users due to budget check failure).
    console.error("[budget] Monthly check error:", (e as { code?: string })?.code);
    return { exceeded: false };
  }

  if (monthlyCostUsd >= monthlyCapUsd) {
    return {
      exceeded: true,
      reason: `Presupuesto mensual de IA agotado ($${monthlyCostUsd.toFixed(2)} / $${monthlyCapUsd}).`,
    };
  }

  // ── 2. Tenant daily token cap ─────────────────────────────────────────────────
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  let tenantDayTokens = 0;
  try {
    const [tenantDay] = await db
      .select({
        total: sql<number>`coalesce(sum(${tables.aiUsage.prompt_tokens} + ${tables.aiUsage.completion_tokens}), 0)::float8`,
      })
      .from(tables.aiUsage)
      .where(
        and(
          eq(tables.aiUsage.tenant_id, tenantId),
          gte(tables.aiUsage.created_at, dayStart.toISOString())
        )
      );
    tenantDayTokens = tenantDay?.total ?? 0;
  } catch (e) {
    console.error("[budget] Tenant daily check error:", (e as { code?: string })?.code);
    return { exceeded: false };
  }

  if (tenantDayTokens >= tenantDailyTokenCap) {
    return {
      exceeded: true,
      reason: `Presupuesto diario de tokens agotado para el tenant (${tenantDayTokens.toLocaleString()} / ${tenantDailyTokenCap.toLocaleString()}).`,
    };
  }

  // ── 3. Per-user daily token cap ───────────────────────────────────────────────
  if (userId) {
    let userDayTokens = 0;
    try {
      const [userDay] = await db
        .select({
          total: sql<number>`coalesce(sum(${tables.aiUsage.prompt_tokens} + ${tables.aiUsage.completion_tokens}), 0)::float8`,
        })
        .from(tables.aiUsage)
        .where(
          and(
            eq(tables.aiUsage.user_id, userId),
            gte(tables.aiUsage.created_at, dayStart.toISOString())
          )
        );
      userDayTokens = userDay?.total ?? 0;
    } catch (e) {
      console.error("[budget] User daily check error:", (e as { code?: string })?.code);
      return { exceeded: false };
    }

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
    await db.insert(tables.aiUsage).values({
      tenant_id: tenantId,
      user_id: userId,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost_usd: costUsd.toFixed(4),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error("[budget] Exception recording AI usage:", name);
  }
}
