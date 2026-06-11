/**
 * /api/admin/prompt-rules — Agent Training Console rules CRUD.
 *
 * GET  — list all rules for the tenant (active + inactive).
 * POST — create a rule. Body: { title, rule_text, rule_type, active? }.
 *
 * Rules are tenant-scoped (RLS + explicit tenant filter), versioned via
 * updated_at + audit events, and NEVER touch source code — active rules are
 * injected into the extraction prompt at runtime (see prompt-rules.ts).
 *
 * Auth: admin/owner (requireAdmin). Audit: PROMPT_RULE_CREATED.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";

const RULE_TYPES = [
  "extraction",
  "classification",
  "severity",
  "missing_fields",
  "reply_style",
  "core_mapping",
] as const;

const CreateRuleSchema = z.object({
  title: z.string().trim().min(3).max(200),
  rule_text: z.string().trim().min(3).max(2_000),
  rule_type: z.enum(RULE_TYPES).default("extraction"),
  active: z.boolean().default(true),
});

const RULE_COLUMNS = "id,title,rule_text,rule_type,active,created_at,updated_at";

export async function GET() {
  try {
    const { supabase, userRow } = await requireAdmin();

    const { data, error } = await (supabase as any)
      .from("agent_prompt_rules")
      .select(RULE_COLUMNS)
      .eq("tenant_id", userRow.tenant_id)
      .order("created_at", { ascending: false });

    if (error) {
      // 42P01 = migration not applied yet — return empty list, not a 500.
      if (error.code === "42P01") return ok({ rules: [] });
      console.error("[admin/prompt-rules GET]", error.code);
      return err(new AppError("INTERNAL_ERROR"));
    }

    return ok({ rules: data ?? [] });
  } catch (e) {
    return err(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { supabase, user, userRow } = await requireAdmin();

    const rl = await rateLimit(
      buildUserKey(user.id, "prompt-rules"),
      RATE_LIMIT_CONFIGS.CASES_API
    );
    if (!rl.allowed) return err(new AppError("RATE_LIMITED"));

    const body = await request.json();
    const parsed = CreateRuleSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { data, error } = await (supabase as any)
      .from("agent_prompt_rules")
      .insert({
        tenant_id: userRow.tenant_id,
        title: parsed.data.title,
        rule_text: parsed.data.rule_text,
        rule_type: parsed.data.rule_type,
        active: parsed.data.active,
        created_by: user.id,
      })
      .select(RULE_COLUMNS)
      .single();

    if (error || !data) {
      console.error("[admin/prompt-rules POST]", error?.code ?? "no_data");
      return err(new AppError("INTERNAL_ERROR"));
    }

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type: AuditEvent.PROMPT_RULE_CREATED,
      target_type: "agent_prompt_rule",
      target_id: data.id,
      payload: { rule_id: data.id, rule_type: data.rule_type, active: data.active },
    });

    return ok({ rule: data }, 201);
  } catch (e) {
    return err(e);
  }
}
