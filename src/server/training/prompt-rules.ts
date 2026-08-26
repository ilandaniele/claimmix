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
import { and, asc, eq } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";

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
  tenantId: string
): Promise<PromptRule[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const t = tables.agentPromptRules;
    const data = await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: t.id,
          title: t.title,
          rule_text: t.rule_text,
          rule_type: t.rule_type,
        })
        .from(t)
        .where(eq(t.active, true))
        .orderBy(asc(t.created_at))
        .limit(MAX_ACTIVE_RULES)
    );

    return data as PromptRule[];
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code && code !== "42P01") {
      console.error("[prompt-rules] load error:", code); // crew-debug-ok
    }
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
