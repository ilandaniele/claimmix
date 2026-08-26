/**
 * PATCH /api/admin/users/:id - update a user's role in the current tenant.
 */

import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const RoleSchema = z.enum(["owner", "admin", "specialist", "analyst", "viewer"]);
const PatchUserSchema = z.object({
  role: RoleSchema,
});

const USER_COLUMNS = {
  id: tables.users.id,
  full_name: tables.users.full_name,
  role: tables.users.role,
  created_at: tables.users.created_at,
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
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("NOT_FOUND");

    const parsed = PatchUserSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    if (params.data.id === user.id) {
      throw new AppError(
        "VALIDATION_FAILED",
        "No podés cambiar tu propio rol desde esta pantalla."
      );
    }

    const existing = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: tables.users.id, role: tables.users.role })
          .from(tables.users)
          .where(
            eq(tables.users.id, params.data.id)
          )
          .limit(1)
      )
    );

    if (!existing) throw new AppError("NOT_FOUND");

    const touchesOwnerRole = existing.role === "owner" || parsed.data.role === "owner";
    if (touchesOwnerRole && userRow.role !== "owner") {
      throw new AppError(
        "FORBIDDEN_ROLE",
        "Solo un owner puede asignar o modificar el rol owner."
      );
    }

    const updated = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .update(tables.users)
          .set({ role: parsed.data.role })
          .where(
            eq(tables.users.id, params.data.id)
          )
          .returning(USER_COLUMNS)
      )
    );

    if (!updated) throw new AppError("NOT_FOUND");

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type: AuditEvent.USER_ROLE_CHANGED,
      target_type: "user",
      target_id: updated.id,
      payload: { previous_role: existing.role, role: updated.role },
    });

    return ok({ user: updated });
  } catch (e) {
    return err(e);
  }
}
