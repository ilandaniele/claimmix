/**
 * PATCH /api/admin/prompt-rules/:id — update or activate/deactivate a rule.
 *
 * Body (all optional): { title?, rule_text?, rule_type?, active? }.
 * Tenant-scoped; audit events PROMPT_RULE_UPDATED / PROMPT_RULE_TOGGLED.
 * Auth: admin/owner.
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

const ParamsSchema = z.object({ id: z.string().uuid() });

const UpdateRuleSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    rule_text: z.string().trim().min(3).max(2_000).optional(),
    rule_type: z
      .enum([
        "extraction",
        "classification",
        "severity",
        "missing_fields",
        "reply_style",
        "core_mapping",
      ])
      .optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nada para actualizar.",
  });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, user, userRow } = await requireAdmin();

    const rl = await rateLimit(
      buildUserKey(user.id, "prompt-rules"),
      RATE_LIMIT_CONFIGS.CASES_API
    );
    if (!rl.allowed) return err(new AppError("RATE_LIMITED"));

    const rawParams = await context.params;
    const parsedParams = ParamsSchema.safeParse(rawParams);
    if (!parsedParams.success) {
      return err(new AppError("NOT_FOUND", "La regla no existe."));
    }

    const body = await request.json();
    const parsed = UpdateRuleSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    // Tenant-scoped fetch first (IDOR-safe 404).
    const { data: existing } = await (supabase as any)
      .from("agent_prompt_rules")
      .select("id,active")
      .eq("id", parsedParams.data.id)
      .eq("tenant_id", userRow.tenant_id)
      .maybeSingle();

    if (!existing) {
      return err(new AppError("NOT_FOUND", "La regla no existe."));
    }

    const { data, error } = await (supabase as any)
      .from("agent_prompt_rules")
      .update(parsed.data)
      .eq("id", parsedParams.data.id)
      .eq("tenant_id", userRow.tenant_id)
      .select("id,title,rule_text,rule_type,active,created_at,updated_at")
      .single();

    if (error || !data) {
      console.error("[admin/prompt-rules PATCH]", error?.code ?? "no_data");
      return err(new AppError("INTERNAL_ERROR"));
    }

    const toggled =
      parsed.data.active !== undefined && parsed.data.active !== existing.active;

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type: toggled
        ? AuditEvent.PROMPT_RULE_TOGGLED
        : AuditEvent.PROMPT_RULE_UPDATED,
      target_type: "agent_prompt_rule",
      target_id: data.id,
      payload: { rule_id: data.id, rule_type: data.rule_type, active: data.active },
    });

    return ok({ rule: data });
  } catch (e) {
    return err(e);
  }
}
