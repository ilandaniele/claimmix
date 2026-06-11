/**
 * AI provider selection — per-tenant switch between OpenAI and Google Gemini.
 *
 * The active provider is resolved in this order:
 *   1. MOCK_AI / AI_MOCK env → "mock" (demo mode, no real LLM calls)
 *   2. tenant_ai_settings.provider for the tenant (set from Configuración)
 *   3. AI_PROVIDER env var
 *   4. default "openai"
 *
 * Whatever is selected, a provider without its API key configured is never
 * used: the resolver falls back to the other provider when possible, and to
 * "mock" only when neither key exists (so the pipeline still degrades
 * gracefully instead of crashing).
 *
 * Fully defensive: a missing tenant_ai_settings table (migration not applied)
 * or any query error silently falls back to the env default.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AiProvider = "openai" | "gemini";
export type ExtractionEngine = AiProvider | "mock";

export const AI_PROVIDERS: readonly AiProvider[] = ["openai", "gemini"] as const;

function isAiProvider(value: unknown): value is AiProvider {
  return value === "openai" || value === "gemini";
}

/** True when the provider's API key is configured (non-empty). */
export function hasProviderKey(provider: AiProvider): boolean {
  const key =
    provider === "gemini"
      ? process.env.GEMINI_API_KEY
      : process.env.OPENAI_API_KEY;
  return Boolean(key && key.trim());
}

/** Env-level default provider (AI_PROVIDER, default "openai"). */
export function getDefaultProvider(): AiProvider {
  const env = process.env.AI_PROVIDER?.trim().toLowerCase();
  return isAiProvider(env) ? env : "openai";
}

/**
 * The tenant's configured provider preference (tenant_ai_settings row),
 * falling back to the env default. Never throws.
 */
export async function getTenantAiProvider(
  supabase: SupabaseClient,
  tenantId: string
): Promise<AiProvider> {
  try {

    const { data, error } = await (supabase as any)
      .from("tenant_ai_settings")
      .select("provider")
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (error || !data) return getDefaultProvider();
    return isAiProvider(data.provider) ? data.provider : getDefaultProvider();
  } catch {
    return getDefaultProvider();
  }
}

/**
 * Resolve which extraction engine to actually run for this tenant,
 * accounting for mock mode and which API keys are configured.
 */
export async function resolveExtractionEngine(
  supabase: SupabaseClient,
  tenantId: string
): Promise<ExtractionEngine> {
  if (process.env.MOCK_AI === "true" || process.env.AI_MOCK === "true") {
    return "mock";
  }

  const preferred = await getTenantAiProvider(supabase, tenantId);
  if (hasProviderKey(preferred)) return preferred;

  const fallback: AiProvider = preferred === "openai" ? "gemini" : "openai";
  if (hasProviderKey(fallback)) {
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "claimmix",
        msg: "ai.provider.fallback",
        preferred,
        used: fallback,
        reason: "missing_api_key",
      })
    );
    return fallback;
  }

  return "mock";
}
