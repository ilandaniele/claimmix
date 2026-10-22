/**
 * PATCH /api/admin/users/:id - update a user's role in the current tenant, or
 * re-enable a user that was deactivated (`{ activo: true }`).
 * DELETE /api/admin/users/:id - deactivate a user: no new session by any path,
 * and the open ones are closed.
 *
 * Baja, alta y rol van en un solo lote con el candado del espacio (`cambiarUsuario`).
 */

import { NextRequest } from "next/server";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { ALL_ROLES, type UserRole } from "@/lib/auth/roles";
import { tables } from "@/lib/db";
import { enControlVarias, type TenantContext } from "@/data/scope";
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

type FilaDeUsuario = Pick<typeof tables.users.$inferSelect, keyof typeof USER_COLUMNS>;

/**
 * El candado por espacio pone en fila a los admins que se tocan entre sí, y la
 * regla mira a quien pide en la base, no en la caché: dos que se dan de baja a la
 * vez no dejan el espacio sin quien lo administre, y uno dado de baja o degradado
 * hace 30 s no cambia a nadie. La lectura del rol previo va después del candado:
 * es el rol de antes. Toda escritura de `users.role` o `dado_de_baja_en` pasa por
 * acá (y quien pide nunca es el objetivo, ver el 400), o la invariante cae.
 *
 * Sin fila, el rol previo dice si fue porque no es de este espacio (NOT_FOUND) o
 * porque la regla no lo dejó (FORBIDDEN_ROLE). El mensaje del owner es sólo para el
 * admin que se topa con uno: si quien pide ya no está activo o ya no es admin, la
 * caché le hacía creer otra cosa y el mensaje le diría que no es lo que es.
 */
async function cambiarUsuario(
  tenantCtx: TenantContext,
  actorId: string,
  id: string,
  cambio: { role: UserRole } | { dado_de_baja_en: SQL | null }
): Promise<{ fila: FilaDeUsuario; rolPrevio: string }> {
  const rolNuevo = "role" in cambio ? cambio.role : null;
  // Un solo fragmento: el mensaje de error y la regla no pueden discrepar sobre quién es un actor vivo.
  const actorVivo = sql`public.users a where a.id = ${actorId}::uuid and a.dado_de_baja_en is null`;
  const res = await enControlVarias(tenantCtx, (db) => [
    db.execute(sql`select pg_advisory_xact_lock(hashtext('admins'), hashtext(${tenantCtx.tenantId}::text))`),
    db
      .select({
        role: tables.users.role,
        actor: sql<string | null>`(select a.role from ${actorVivo})`,
      })
      .from(tables.users)
      .where(eq(tables.users.id, id))
      .limit(1),
    db
      .update(tables.users)
      .set(cambio)
      .where(
        and(
          eq(tables.users.id, id),
          // Un admin no toca owners ni asigna owner; `is distinct from` porque en la baja y el alta el rol nuevo es null.
          sql`exists (select 1 from ${actorVivo} and (a.role = 'owner' or (a.role = 'admin' and ${tables.users.role} <> 'owner' and ${rolNuevo}::text is distinct from 'owner')))`
        )
      )
      .returning(USER_COLUMNS),
  ]);

  const previa = firstRow(res[1] as { role: string; actor: string | null }[]);
  if (!previa) throw new AppError("NOT_FOUND");
  const fila = firstRow(res[2] as FilaDeUsuario[]);
  if (fila) return { fila, rolPrevio: previa.role };

  if (previa.actor === "admin" && (previa.role === "owner" || rolNuevo === "owner")) {
    throw new AppError(
      "FORBIDDEN_ROLE",
      rolNuevo
        ? "Solo un owner puede asignar o modificar el rol owner."
        : "Solo un owner puede dar de baja o habilitar a un owner."
    );
  }
  throw new AppError("FORBIDDEN_ROLE");
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
      const { fila: habilitado } = await cambiarUsuario(tenantCtx, user.id, params.data.id, { dado_de_baja_en: null });
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

    const { fila: updated, rolPrevio } = await cambiarUsuario(tenantCtx, user.id, params.data.id, { role });

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
      payload: { previous_role: rolPrevio, role: updated.role },
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

    // Con esto y el candado de cambiarUsuario, al espacio siempre le queda quien lo administre.
    if (params.data.id === user.id) {
      throw new AppError("VALIDATION_FAILED", "No podés darte de baja a vos mismo.");
    }

    // Primero la baja: desde acá el gancho de sesión no abre ninguna nueva.
    // coalesce: repetir la baja no le cambia la fecha.
    const { fila: dado } = await cambiarUsuario(tenantCtx, user.id, params.data.id, {
      dado_de_baja_en: sql`coalesce(${tables.users.dado_de_baja_en}, now())`,
    });

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
