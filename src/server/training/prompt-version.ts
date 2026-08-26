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
import { and, eq } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";

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
  tenantId: string
): Promise<ActivePromptVersion> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const t = tables.promptVersions;
    const row = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: t.id, version: t.version, system_prompt: t.system_prompt })
          .from(t)
          .where(eq(t.active, true))
          .limit(1)
      )
    );

    if (!row) return BUILTIN;

    return {
      id: row.id,
      version: row.version,
      systemPrompt: row.system_prompt?.trim() ? row.system_prompt : null,
    };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code && code !== "42P01") {
      console.error("[prompt-version] load error:", code); // crew-debug-ok
    }
    // Never break extraction because the prompt version could not be loaded.
    return BUILTIN;
  }
}
