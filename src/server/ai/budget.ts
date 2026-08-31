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
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";

/** @deprecated Legacy constants for gpt-4o-mini. Use computeCostUsd(tokens, tokens, model). */
export const COST_PER_PROMPT_TOKEN = 0.00000015;
export const COST_PER_COMPLETION_TOKEN = 0.00000060;

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.00000015, output: 0.00000060 },
  "gpt-4o":      { input: 0.0000025,  output: 0.00001 },
  // Gemini por Vertex, precio de lista por token. El tope mensual existía y no
  // servía para nada: la extracción registraba cost_usd = 0 con el comentario
  // "free tier", que fue cierto mientras corría por AI Studio. Al pasar a
  // Vertex postpago dejó de serlo, y nada avisó — un tope de USD contra una
  // suma que siempre da cero no salta nunca.
  //
  // Es una estimación, no la factura. Su trabajo es que el tope deje de ser
  // decorativo; para conciliar plata está la consola de Google.
  "gemini-2.5-flash":      { input: 0.0000003,  output: 0.0000025 },
  "gemini-2.5-flash-lite": { input: 0.0000001,  output: 0.0000004 },
  "gemini-2.5-pro":        { input: 0.00000125, output: 0.00001 },
};

/**
 * Precio por token del modelo, tolerando los nombres que devuelve Vertex.
 *
 * Un modelo afinado llega como `projects/…/locations/…/models/1234567890` y no
 * va a coincidir con ninguna clave. Cobra como su modelo base, que es lo que
 * hace Google, así que la aproximación correcta es "flash" y no "gratis".
 */
function ratesFor(model?: string): { input: number; output: number } {
  const name = (model ?? "").toLowerCase();
  if (MODEL_COSTS[name]) return MODEL_COSTS[name]!;
  for (const [key, rates] of Object.entries(MODEL_COSTS)) {
    if (key.startsWith("gemini") && name.includes(key)) return rates;
  }
  if (name.includes("gemini") || name.startsWith("projects/")) {
    return MODEL_COSTS["gemini-2.5-flash"]!;
  }
  return MODEL_COSTS["gpt-4o-mini"]!;
}

/**
 * Compute estimated cost for a given token usage.
 * Pass model to get per-model pricing; unknown names fall back to a base rate
 * rather than to zero — see ratesFor.
 */
export function computeCostUsd(promptTokens: number, completionTokens: number, model?: string): number {
  const rates = ratesFor(model);
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
 * Un tope leído del entorno, que cae al default si el valor no es un número.
 *
 * `parseInt("")` da NaN, y `total >= NaN` es false para cualquier total: una
 * variable vacía o mal escrita no relaja el tope, lo apaga entero y en
 * silencio. Es la misma forma que tenía el `cost_usd = 0` — un techo que no se
 * puede alcanzar nunca avisa de que no está.
 *
 * Un cero se respeta: apagar el gasto a propósito es una decisión válida. Lo
 * que no se acepta es basura, un negativo, o la variable vacía que deja un
 * workflow cuando el secreto que la llena no existe.
 */
function readCap(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!raw?.trim() || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * El tenant de la demo pública, si está configurado.
 *
 * Deliberadamente sin fallback al tenant de producción. Que la demo se caiga
 * porque falta una variable es un problema de la demo; que la demo comparta
 * presupuesto con las denuncias reales es un problema del asegurado.
 */
export function getDemoTenantId(): string | null {
  return process.env.DEMO_TENANT_ID?.trim() || null;
}

/**
 * El techo de la demo pública, que es plata que se puede perder.
 *
 * Separado de checkBudget a propósito: acá el peor caso es que la demo deje de
 * andar hasta mañana, y eso es aceptable. Allá el peor caso es que un
 * asegurador se quede sin intake, y no lo es. Nadie autenticado pasa por acá.
 */
export async function checkDemoBudget(): Promise<BudgetCheckResult> {
  const demoTenantId = getDemoTenantId();
  if (!demoTenantId) {
    return { exceeded: true, reason: "La demo no tiene tenant propio configurado." };
  }
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId: demoTenantId };

  const dailyTokenCap = readCap(process.env.AI_DEMO_DAILY_TOKEN_CAP, 300_000);
  const monthlyCapUsd = readCap(process.env.DEMO_MONTHLY_BUDGET_USD, 10);

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  try {
    const [day] = await enTenant(tenantCtx, (db) =>
      db
        .select({
          tokens: sql<number>`coalesce(sum(${tables.aiUsage.prompt_tokens} + ${tables.aiUsage.completion_tokens}), 0)::float8`,
        })
        .from(tables.aiUsage)
        .where(
          and(
            gte(tables.aiUsage.created_at, dayStart.toISOString())
          )
        )
    );

    if ((day?.tokens ?? 0) >= dailyTokenCap) {
      return { exceeded: true, reason: "La demo alcanzó su cupo diario." };
    }

    const [month] = await enTenant(tenantCtx, (db) =>
      db
        .select({ usd: sql<number>`coalesce(sum(${tables.aiUsage.cost_usd}), 0)::float8` })
        .from(tables.aiUsage)
        .where(
          and(
            gte(tables.aiUsage.created_at, monthStart.toISOString())
          )
        )
    );

    if ((month?.usd ?? 0) >= monthlyCapUsd) {
      return { exceeded: true, reason: "La demo alcanzó su cupo mensual." };
    }

    return { exceeded: false };
  } catch (e) {
    /*
     * Acá sí, cerrado.
     *
     * Es la única diferencia de criterio con checkBudget, y es a propósito: si
     * no se puede saber cuánto lleva gastado un endpoint anónimo, seguir
     * gastando es la decisión cara. La demo se apaga un rato; nadie que esté
     * denunciando un siniestro se entera.
     */
    console.error("[budget] demo check error:", (e as { code?: string })?.code); // crew-debug-ok
    return { exceeded: true, reason: "No se pudo verificar el cupo de la demo." };
  }
}

/**
 * Check if AI budget is available for the current tenant.
 *
 * Checks:
 *   1. Monthly project-level cost cap ($200 by default), excluding the public
 *      demo — see the comment inside.
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
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const monthlyCapUsd = readCap(process.env.MONTHLY_BUDGET_USD, 200);
  const tenantDailyTokenCap = readCap(process.env.AI_TENANT_DAILY_TOKEN_CAP, 5_000_000);
  const userDailyTokenCap = readCap(process.env.AI_USER_DAILY_TOKEN_CAP, 100_000);

  // ── 1. Monthly cost check (project-wide) ─────────────────────────────────────
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  /*
   * El tope mensual es del proyecto entero, y eso es lo que se quiere: protege
   * la tarjeta. Lo que no puede hacer es contar lo que gasta la demo pública.
   *
   * Ese endpoint corre sin autenticación, y hasta ahora su gasto sumaba acá.
   * Un anónimo con IPs rotativas llegaba al tope y a partir de ahí ninguna
   * denuncia real se extraía — sin que fallara nada en voz alta: el worker
   * anota un warn y el caso se queda esperando. La demo tiene su propio tope,
   * en checkDemoBudget.
   */
  const demoTenantId = getDemoTenantId();

  let monthlyCostUsd = 0;
  try {
    /*
     * El tope mensual es del PROYECTO, no de cada aseguradora.
     *
     * Esta consulta corría dentro de `enTenant`, o sea acotada por RLS al
     * inquilino que estaba pidiendo. Con eso, el tope de US$200 pasaba a ser
     * US$200 POR aseguradora: con cuatro inquilinos activos gastando 199 cada
     * uno, el gasto real es 796, ninguno de los cuatro se pasa de su propia
     * cuenta, y los cuatro siguen extrayendo. El techo declarado es 200 y la
     * tarjeta paga 796.
     *
     * El `ne(tenant_id, demoTenantId)` de abajo lo delata: descontar la demo
     * sólo tiene sentido si la suma cruza inquilinos. Acotada por RLS, esa
     * cláusula no podía hacer nada — descuenta filas que la consulta no veía.
     *
     * `/api/health` ya suma así, sin `enTenant`, y por eso el número que muestra
     * y el que gobierna el corte no eran el mismo.
     */
    // sin-inquilino: el tope de gasto es del proyecto entero, así que la suma
    // tiene que cruzar inquilinos. Ver el bloque de arriba.
    const [monthly] = await db
      .select({
        total: sql<number>`coalesce(sum(${tables.aiUsage.cost_usd}), 0)::float8`,
      })
      .from(tables.aiUsage)
      .where(
        demoTenantId
          ? and(
              gte(tables.aiUsage.created_at, monthStart.toISOString()),
              ne(tables.aiUsage.tenant_id, demoTenantId)
            )
          : gte(tables.aiUsage.created_at, monthStart.toISOString())
      );
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
    const [tenantDay] = await enTenant(tenantCtx, (db) =>
      db
        .select({
          total: sql<number>`coalesce(sum(${tables.aiUsage.prompt_tokens} + ${tables.aiUsage.completion_tokens}), 0)::float8`,
        })
        .from(tables.aiUsage)
        .where(
          and(
            gte(tables.aiUsage.created_at, dayStart.toISOString())
          )
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
      const [userDay] = await enTenant(tenantCtx, (db) =>
        db
          .select({
            total: sql<number>`coalesce(sum(${tables.aiUsage.prompt_tokens} + ${tables.aiUsage.completion_tokens}), 0)::float8`,
          })
          .from(tables.aiUsage)
          .where(
            and(
              eq(tables.aiUsage.user_id, userId),
              gte(tables.aiUsage.created_at, dayStart.toISOString())
            )
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
    await enTenant({ tenantId }, (db) =>
      db.insert(tables.aiUsage).values({
        tenant_id: tenantId,
        user_id: userId,
        model,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cost_usd: costUsd.toFixed(4),
      })
    );
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error("[budget] Exception recording AI usage:", name);
  }
}
