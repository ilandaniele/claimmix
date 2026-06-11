/**
 * prompt_versions — versioned system-prompt records per tenant.
 *
 * The built-in prompt in src/server/ai/prompt.ts remains the base. A tenant
 * may have at most one ACTIVE prompt_versions row (partial unique index);
 * its system_prompt text is injected as an additional operator guidance block,
 * and its id/version are recorded on every agent_runs row so each extraction
 * is traceable to the exact prompt that produced it.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Version label recorded when no tenant prompt_versions row is active. */
export const BUILTIN_PROMPT_VERSION = "builtin-v1";

export interface ActivePromptVersion {
  /** prompt_versions.id, or null when using the built-in prompt. */
  id: string | null;
  /** Human-readable version label, e.g. "builtin-v1" or "tenant-v3". */
  version: string;
  /** Operator-authored prompt text to inject; null for built-in. */
  systemPrompt: string | null;
}

const BUILTIN: ActivePromptVersion = {
  id: null,
  version: BUILTIN_PROMPT_VERSION,
  systemPrompt: null,
};

/**
 * Load the active prompt version for a tenant.
 * Falls back to the built-in version on any error or when none is active.
 */
export async function getActivePromptVersion(
  supabase: SupabaseClient,
  tenantId: string
): Promise<ActivePromptVersion> {
  try {
    const { data, error } = await (supabase as any)
      .from("prompt_versions")
      .select("id,version,system_prompt")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      if (error && error.code !== "42P01") {
        console.error("[prompt-version] load error:", error.code); // crew-debug-ok
      }
      return BUILTIN;
    }

    const row = data as { id: string; version: string; system_prompt: string };
    return {
      id: row.id,
      version: row.version,
      systemPrompt: row.system_prompt?.trim() ? row.system_prompt : null,
    };
  } catch {
    // Never break extraction because the prompt version could not be loaded.
    return BUILTIN;
  }
}
