/**
 * PATCH /api/admin/prompt-rules/:id — update or activate/deactivate a rule.
 *
 * Body (all optional): { title?, rule_text?, rule_type?, active? }.
 * Tenant-scoped; audit events PROMPT_RULE_UPDATED / PROMPT_RULE_TOGGLED.
 * Auth: admin/owner.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
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

const t = tables.agentPromptRules;

const RULE_COLUMNS = {
  id: t.id,
  title: t.title,
  rule_text: t.rule_text,
  rule_type: t.rule_type,
  active: t.active,
  created_at: t.created_at,
  updated_at: t.updated_at,
};

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { db, user, userRow } = await requireAdmin();
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };

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

    // Tenant-scoped fetch first (IDOR-safe 404). A DB error here degrades to
    // NOT_FOUND, matching the previous (error-ignoring) Neon behavior.
    let existing: { id: string; active: boolean } | null;
    try {
      existing = firstRow(
        await enTenant(tenantCtx, (db) =>
          db
            .select({ id: t.id, active: t.active })
            .from(t)
            .where(
              eq(t.id, parsedParams.data.id)
            )
            .limit(1)
        )
      );
    } catch {
      existing = null;
    }

    if (!existing) {
      return err(new AppError("NOT_FOUND", "La regla no existe."));
    }

    let data;
    try {
      data = firstRow(
        await enTenant(tenantCtx, (db) =>
          db
            .update(t)
            .set(parsed.data)
            .where(
              eq(t.id, parsedParams.data.id)
            )
            .returning(RULE_COLUMNS)
        )
      );
    } catch (e) {
      console.error(
        "[admin/prompt-rules PATCH]",
        (e as { code?: string })?.code ?? "unknown"
      );
      return err(new AppError("INTERNAL_ERROR"));
    }

    if (!data) {
      console.error("[admin/prompt-rules PATCH]", "no_data");
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
