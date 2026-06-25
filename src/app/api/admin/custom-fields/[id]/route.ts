/**
 * /api/admin/custom-fields/:id - update one custom field definition.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { requireAdmin } from "@/lib/auth/require-admin";
import { tables } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

export const dynamic = "force-dynamic";

const FieldTypeSchema = z.enum(["text", "number", "date", "boolean", "enum", "email", "phone"]);
const ClaimTypeSchema = z.enum([
  "choque", "robo", "granizo", "incendio", "other",
  "cristales", "rc", "robo_contenido", "accidente_personal",
]);
const ParamsSchema = z.object({ id: z.string().uuid() });

const PatchCustomFieldSchema = z.object({
  label: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  field_type: FieldTypeSchema.optional(),
  claim_type: ClaimTypeSchema.nullable().optional(),
  required: z.boolean().optional(),
  ask_if_missing: z.boolean().optional(),
  enum_values: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  active: z.boolean().optional(),
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

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { db, user, userRow } = await requireAdmin();
    const rawParams = await context.params;
    const params = ParamsSchema.safeParse(rawParams);
    if (!params.success) throw new AppError("NOT_FOUND");

    const parsed = PatchCustomFieldSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      throw new AppError("VALIDATION_FAILED", "No hay cambios para guardar.");
    }

    const updateValues = {
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.field_type !== undefined ? { field_type: patch.field_type } : {}),
      ...("claim_type" in patch ? { claim_type: patch.claim_type ?? null } : {}),
      ...(patch.required !== undefined ? { required: patch.required } : {}),
      ...(patch.ask_if_missing !== undefined ? { ask_if_missing: patch.ask_if_missing } : {}),
      ...(patch.enum_values !== undefined ? { enum_values: patch.enum_values } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updated_at: new Date().toISOString(),
    };

    const field = firstRow(
      await db
        .update(t)
        .set(updateValues)
        .where(and(eq(t.id, params.data.id), eq(t.tenant_id, userRow.tenant_id)))
        .returning(CUSTOM_FIELD_COLUMNS)
    );

    if (!field) throw new AppError("NOT_FOUND");

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type:
        "active" in patch && Object.keys(patch).length === 1
          ? AuditEvent.CUSTOM_FIELD_TOGGLED
          : AuditEvent.CUSTOM_FIELD_UPDATED,
      target_type: "agent_custom_field",
      target_id: field.id,
      payload: { key: field.key, active: field.active },
    });

    return ok({ field });
  } catch (e) {
    return err(e);
  }
}
