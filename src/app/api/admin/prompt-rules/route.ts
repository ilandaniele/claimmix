/**
 * /api/admin/prompt-rules — Agent Training Console rules CRUD.
 *
 * GET  — list all rules for the tenant (active + inactive).
 * POST — create a rule. Body: { title, rule_text, rule_type, active? }.
 *
 * Rules are tenant-scoped (explicit tenant_id filter — the only isolation
 * boundary now that RLS is gone), versioned via updated_at + audit events,
 * and NEVER touch source code — active rules are injected into the
 * extraction prompt at runtime (see prompt-rules.ts).
 *
 * Auth: admin/owner (requireAdmin). Audit: PROMPT_RULE_CREATED.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
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

export async function GET() {
  try {
    const { userRow } = await requireAdmin();
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };

    let data;
    try {
      data = await enTenant(tenantCtx, (db) =>
        db
          .select(RULE_COLUMNS)
          .from(t)
          .orderBy(desc(t.created_at))
      );
    } catch (e) {
      const code = (e as { code?: string })?.code;
      // 42P01 = migration not applied yet — return empty list, not a 500.
      if (code === "42P01") return ok({ rules: [] });
      console.error("[admin/prompt-rules GET]", code ?? "unknown");
      return err(new AppError("INTERNAL_ERROR"));
    }

    return ok({ rules: data ?? [] });
  } catch (e) {
    return err(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, userRow } = await requireAdmin();

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

    let data;
    try {
      data = firstRow(
        await enTenant({ tenantId: userRow.tenant_id }, (db) =>
          db
            .insert(t)
            .values({
              tenant_id: userRow.tenant_id,
              title: parsed.data.title,
              rule_text: parsed.data.rule_text,
              rule_type: parsed.data.rule_type,
              active: parsed.data.active,
              created_by: user.id,
            })
            .returning(RULE_COLUMNS)
        )
      );
    } catch (e) {
      console.error(
        "[admin/prompt-rules POST]",
        (e as { code?: string })?.code ?? "unknown"
      );
      return err(new AppError("INTERNAL_ERROR"));
    }

    if (!data) {
      console.error("[admin/prompt-rules POST]", "no_data");
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
