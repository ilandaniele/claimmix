/**
 * DELETE /api/admin/users/:id/sessions - cierra todas las sesiones de una persona del inquilino.
 *
 * Sirve cuando alguien perdió el teléfono: sin esto, una sesión robada seguía
 * viva hasta treinta días. Las sesiones abiertas caen dentro de los 60 s del
 * `cookieCache` de Better Auth, no al instante, y la persona puede volver a
 * entrar. Para dejarla afuera (se fue de la empresa) está la baja:
 * DELETE /api/admin/users/:id.
 */

import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { cerrarSesiones } from "@/lib/auth/sesiones";
import { tables } from "@/lib/db";
import { enControl, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.guid() });

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { user, userRow } = await requireAdmin();
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("NOT_FOUND");

    if (params.data.id === user.id) {
      throw new AppError("VALIDATION_FAILED", "Cerrá tu propia sesión desde el menú.");
    }

    const objetivo = firstRow(
      await enControl(tenantCtx, (db) =>
        db
          .select({ id: tables.users.id, role: tables.users.role })
          .from(tables.users)
          .where(eq(tables.users.id, params.data.id))
          .limit(1)
      )
    );
    if (!objetivo) throw new AppError("NOT_FOUND");

    if (objetivo.role === "owner" && userRow.role !== "owner") {
      throw new AppError("FORBIDDEN_ROLE", "Solo un owner puede cerrar las sesiones de un owner.");
    }

    // Si tira, no se audita: «0 sesiones cerradas» no puede quedar como un éxito.
    const sesionesCerradas = await cerrarSesiones(params.data.id);

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type: AuditEvent.USER_SESSIONS_REVOKED,
      target_type: "user",
      target_id: params.data.id,
      payload: { sesiones_cerradas: sesionesCerradas },
    });

    return ok({ sesiones_cerradas: sesionesCerradas });
  } catch (e) {
    return err(e);
  }
}
