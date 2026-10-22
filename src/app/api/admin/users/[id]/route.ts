/**
 * PATCH /api/admin/users/:id - update a user's role in the current tenant, or
 * re-enable a user that was deactivated (`{ activo: true }`).
 * DELETE /api/admin/users/:id - deactivate a user: no new session by any path,
 * and the open ones are closed.
 */

import { NextRequest } from "next/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { ALL_ROLES } from "@/lib/auth/roles";
import { tables } from "@/lib/db";
import { enControl, type TenantContext } from "@/data/scope";
import { espejarSinFallar } from "@/server/bases/espejar-sin-fallar";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { olvidarFilaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";
import { cerrarSesiones } from "@/lib/auth/sesiones";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.guid() });
const RoleSchema = z.enum(ALL_ROLES);
const PatchUserSchema = z.union([
  z.object({ role: RoleSchema }),
  z.object({ activo: z.literal(true) }),
]);

const USER_COLUMNS = {
  id: tables.users.id,
  full_name: tables.users.full_name,
  role: tables.users.role,
  created_at: tables.users.created_at,
  dado_de_baja_en: tables.users.dado_de_baja_en,
};

/**
 * Da de baja o vuelve a habilitar en una sola sentencia: la regla del owner viaja
 * en el WHERE. Sin fila, una segunda lectura dice si fue porque no es de este
 * espacio (NOT_FOUND) o porque es un owner y quien pide no lo es.
 */
async function marcarBaja(tenantCtx: TenantContext, rolDeQuienPide: string, id: string, baja: boolean) {
  const delEspacio = eq(tables.users.id, id);
  const marcada = firstRow(
    await enControl(tenantCtx, (db) =>
      db
        .update(tables.users)
        // coalesce: repetir la baja no le cambia la fecha.
        .set({ dado_de_baja_en: baja ? sql`coalesce(${tables.users.dado_de_baja_en}, now())` : null })
        .where(rolDeQuienPide === "owner" ? delEspacio : and(delEspacio, ne(tables.users.role, "owner")))
        .returning(USER_COLUMNS)
    )
  );
  if (marcada) return marcada;

  const existe = firstRow(
    await enControl(tenantCtx, (db) =>
      db.select({ id: tables.users.id }).from(tables.users).where(delEspacio).limit(1)
    )
  );
  if (!existe) throw new AppError("NOT_FOUND");
  throw new AppError("FORBIDDEN_ROLE", "Solo un owner puede dar de baja o habilitar a un owner.");
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { user, userRow } = await requireAdmin();
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

    if ("activo" in parsed.data) {
      const habilitado = await marcarBaja(tenantCtx, userRow.role, params.data.id, false);
      await espejarSinFallar(userRow.tenant_id);
      olvidarFilaDeUsuario(params.data.id);
      await writeAuditLog({
        tenant_id: userRow.tenant_id,
        actor_id: user.id,
        event_type: AuditEvent.USER_REACTIVATED,
        target_type: "user",
        target_id: habilitado.id,
      });
      return ok({ user: habilitado });
    }
    const { role } = parsed.data;

    const existing = firstRow(
      await enControl(tenantCtx, (db) =>
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

    const touchesOwnerRole = existing.role === "owner" || role === "owner";
    if (touchesOwnerRole && userRow.role !== "owner") {
      throw new AppError(
        "FORBIDDEN_ROLE",
        "Solo un owner puede asignar o modificar el rol owner."
      );
    }

    const updated = firstRow(
      await enControl(tenantCtx, (db) =>
        db
          .update(tables.users)
          .set({ role })
          .where(
            eq(tables.users.id, params.data.id)
          )
          .returning(USER_COLUMNS)
      )
    );

    if (!updated) throw new AppError("NOT_FOUND");

    // El rol vive en control; la copia en la base del cliente puede quedar pendiente sin romper el cambio.
    await espejarSinFallar(userRow.tenant_id);

    /*
     * El rol acaba de cambiar, así que la fila cacheada miente.
     *
     * Esto limpia SÓLO la instancia que atendió este PATCH; las demás esperan
     * el TTL. Un degradado conserva el rol viejo hasta treinta segundos donde
     * ya lo tenían en memoria, que es el precio dicho de la caché.
     */
    olvidarFilaDeUsuario(params.data.id);

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

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { user, userRow } = await requireAdmin();
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("NOT_FOUND");

    // Con esto y la regla del owner, al espacio siempre le queda quien lo administre.
    if (params.data.id === user.id) {
      throw new AppError("VALIDATION_FAILED", "No podés darte de baja a vos mismo.");
    }

    // Primero la baja: desde acá el gancho de sesión no abre ninguna nueva.
    const dado = await marcarBaja(tenantCtx, userRow.role, params.data.id, true);

    // Si tira, no se audita: la baja quedó y repetir el pedido cierra lo que falte.
    const sesionesCerradas = await cerrarSesiones(dado.id);

    // Esta instancia deja de servir la fila ya; las demás, al vencer su caché (30 s).
    olvidarFilaDeUsuario(dado.id);
    await espejarSinFallar(userRow.tenant_id);

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type: AuditEvent.USER_DEACTIVATED,
      target_type: "user",
      target_id: dado.id,
      payload: { sesiones_cerradas: sesionesCerradas },
    });

    return ok({ user: dado, sesiones_cerradas: sesionesCerradas });
  } catch (e) {
    return err(e);
  }
}
