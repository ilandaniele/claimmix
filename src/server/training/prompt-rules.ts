/**
 * agent_prompt_rules — operator-authored rules for the extraction agent.
 *
 * Rules are written in the Agent Training Console ("Si el email menciona
 * choque, clasificar como vehicle_collision"), stored tenant-scoped, and the
 * ACTIVE ones are injected into the extraction prompt inside an
 * <agent_rules> sentinel block. Rules never overwrite source code and can
 * never override the prompt's SECURITY RULES (the prompt says so explicitly).
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type PromptRuleType =
  | "extraction"
  | "classification"
  | "severity"
  | "missing_fields"
  | "reply_style"
  | "core_mapping";

export interface PromptRule {
  id: string;
  title: string;
  rule_text: string;
  rule_type: PromptRuleType;
}

/** Max rules injected per run — keeps the prompt bounded. */
const MAX_ACTIVE_RULES = 50;

/** Max total characters of rule text injected per run. */
const MAX_RULES_CHARS = 6_000;

/**
 * Load active prompt rules for a tenant, oldest first (stable order so the
 * prompt is deterministic for caching/debugging).
 */
export async function loadActivePromptRules(
  supabase: SupabaseClient,
  tenantId: string
): Promise<PromptRule[]> {
  try {
    const { data, error } = await (supabase as any)
      .from("agent_prompt_rules")
      .select("id,title,rule_text,rule_type")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(MAX_ACTIVE_RULES);

    if (error || !data) {
      if (error && error.code !== "42P01") {
        console.error("[prompt-rules] load error:", error.code); // crew-debug-ok
      }
      return [];
    }

    return data as PromptRule[];
  } catch {
    // Never break extraction because rules could not be loaded.
    return [];
  }
}

/**
 * Format rules into the text block injected into the prompt.
 * Returns "" when there are no rules.
 */
export function formatPromptRules(rules: PromptRule[]): string {
  if (rules.length === 0) return "";

  const lines: string[] = [];
  let used = 0;

  for (const rule of rules) {
    const line = `- [${rule.rule_type}] ${rule.title}: ${rule.rule_text}`.trim();
    if (used + line.length > MAX_RULES_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join("\n");
}
