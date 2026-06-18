/**
 * /api/admin/custom-fields - tenant custom field registry for the claim agent.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";

import { requireAdmin } from "@/lib/auth/require-admin";
import { tables } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

export const dynamic = "force-dynamic";

const FieldTypeSchema = z.enum(["text", "number", "date", "boolean", "enum", "email", "phone"]);
const ClaimTypeSchema = z.enum(["choque", "robo", "granizo", "incendio", "other"]);

const CreateCustomFieldSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/),
  label: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(""),
  field_type: FieldTypeSchema.default("text"),
  claim_type: ClaimTypeSchema.nullable().optional(),
  required: z.boolean().default(false),
  ask_if_missing: z.boolean().default(false),
  enum_values: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  active: z.boolean().default(true),
});

const t = tables.agentCustomFields;

const CUSTOM_FIELD_COLUMNS = {
  id: t.id,
  key: t.key,
  label: t.label,
  description: t.description,
  field_type: t.field_type,
  claim_type: t.claim_type,
  required: t.required,
  ask_if_missing: t.ask_if_missing,
  enum_values: t.enum_values,
  active: t.active,
  created_at: t.created_at,
  updated_at: t.updated_at,
};

export async function GET() {
  try {
    const { db, userRow } = await requireAdmin();
    try {
      const fields = await db
        .select(CUSTOM_FIELD_COLUMNS)
        .from(t)
        .where(eq(t.tenant_id, userRow.tenant_id))
        .orderBy(asc(t.key));
      return ok({ fields });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "42P01" || code === "42703") return ok({ fields: [] });
      console.error("[admin/custom-fields GET]", code ?? "unknown");
      return err(new AppError("INTERNAL_ERROR"));
    }
  } catch (e) {
    return err(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { db, user, userRow } = await requireAdmin();
    const parsed = CreateCustomFieldSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const field = firstRow(
      await db
        .insert(t)
        .values({
          tenant_id: userRow.tenant_id,
          key: parsed.data.key,
          label: parsed.data.label,
          description: parsed.data.description,
          field_type: parsed.data.field_type,
          claim_type: parsed.data.claim_type ?? null,
          required: parsed.data.required,
          ask_if_missing: parsed.data.ask_if_missing,
          enum_values: parsed.data.enum_values,
          active: parsed.data.active,
          created_by: user.id,
        })
        .returning(CUSTOM_FIELD_COLUMNS)
    );

    if (!field) return err(new AppError("INTERNAL_ERROR"));

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type: AuditEvent.CUSTOM_FIELD_CREATED,
      target_type: "agent_custom_field",
      target_id: field.id,
      payload: { key: field.key, field_type: field.field_type, active: field.active },
    });

    return ok({ field }, 201);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "23505") {
      return err(new AppError("VALIDATION_FAILED", "Ya existe un campo con esa clave."));
    }
    return err(e);
  }
}
