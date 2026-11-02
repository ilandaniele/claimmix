/**
 * DELETE /api/admin/users/:id/cuenta - borra a una persona que ya estaba dada de
 * baja: su perfil (`users`) y su cuenta de Better Auth (`"user"`, con sus sesiones
 * y cuentas en cascada). La dirección queda libre para invitarla de nuevo.
 *
 * El historial se conserva: toda clave foránea hacia la persona es SET NULL (casos,
 * auditoría, uso de IA) salvo lo que es sólo suyo (`user_ai_settings`,
 * `asistente_turnos`), que se va con ella. Si alguna referencia lo frena (23503)
 * se contesta 409: no se fuerza nada.
 *
 * Con un caso asignado, o con algo que firmó en un caso, no se borra: el SET NULL
 * reiniciaría los relojes del caso o haría pasar sus intervenciones por trabajo del
 * agente (ver `casoQueRetiene`). Hay que reasignar los casos; lo firmado no se
 * puede soltar, y la persona queda dada de baja.
 *
 * El asiento `auth.user_deleted` sale de la misma sentencia que el borrado, en el
 * registro de control, y lleva la huella de la dirección: con ella una invitación
 * emitida antes del borrado deja de valer (ver `invitacion.ts`), y no hay borrado
 * sin asiento.
 *
 * `claimmix_app` no puede borrar de `"user"`, así que se escribe con el dueño y
 * sin RLS: el inquilino va a mano en cada WHERE, y toda la regla vive en el WHERE
 * del DELETE, no en una lectura previa que otro pedido podría dejar vieja. La
 * lectura de antes (`previa`) sólo elige el mensaje de error.
 */

import { NextRequest } from "next/server";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { candadoDeAdmins } from "@/lib/auth/candado-de-admins";
import { olvidarFilaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";
import { operatorEmails } from "@/lib/auth/operator-emails";
import { requireAdmin } from "@/lib/auth/require-admin";
import { db } from "@/lib/db";
import { filasDe } from "@/lib/db/filas";
import { firstRow } from "@/lib/db/helpers";
import { ssoSettings } from "@/lib/db/schema";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { AuditEvent } from "@/lib/audit/log";
import { getT } from "@/lib/i18n";
import { resolveAccountLocale } from "@/lib/i18n/locale";
import { huellaDeCorreo } from "@/server/alta/huella-de-correo";
import { espejarSinFallar } from "@/server/bases/espejar-sin-fallar";
import { casoQueRetiene } from "@/server/cases/asignados-a";
import { codigoPg } from "@/server/core-sync/config";
import { VIGENTE } from "@/server/sso/config";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.guid() });

type Previa = { role: string; de_baja: boolean; actor_rol: string | null; sso: boolean; operador: boolean };

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { user, userRow } = await requireAdmin();
    const t = getT(await resolveAccountLocale(userRow.locale));
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("NOT_FOUND");

    const id = params.data.id;
    const tenant = userRow.tenant_id;
    if (id === user.id) throw new AppError("VALIDATION_FAILED", t("usuarios.eliminar.propio"));

    // Quien pide, mirado en la base y no en la caché: un admin dado de baja o degradado hace segundos no borra a nadie.
    const actorVivo = sql`public.users a where a.id = ${user.id}::uuid and a.tenant_id = ${tenant}::uuid and a.dado_de_baja_en is null and a.role in ('owner', 'admin')`;
    // Con SSO vigente el ingreso vuelve a crear a la persona.
    const entraPorSso = sql`exists (select 1 from public.sso_settings where ${ssoSettings.tenant_id} = ${tenant}::uuid and ${VIGENTE} and ${ssoSettings.dominio} = regexp_replace(lower(split_part(btrim(u.email), '@', 2)), '\\.$', ''))`;
    // Las direcciones de ADMIN_EMAILS se vuelven a crear solas al entrar.
    const esOperador = inArray(sql`lower(u.email)`, operatorEmails());
    // Con casos asignados o firmados el SET NULL cambiaría lo que ven los casos (ver asignados-a.ts).
    const retiene = await casoQueRetiene(tenant, id);

    let lote: unknown[];
    try {
      lote = await db.batch([
        // sin-inquilino: el candado es de la base y su clave lleva el inquilino.
        db.execute(candadoDeAdmins(tenant)),
        // sin-inquilino: lectura sólo para elegir el mensaje; filtra por inquilino a mano.
        db.execute(sql`
          select t.role,
                 t.dado_de_baja_en is not null as de_baja,
                 (select a.role from ${actorVivo}) as actor_rol,
                 ${entraPorSso} as sso,
                 ${esOperador} as operador
          from public.users t
          join public."user" u on u.id = t.id
          where t.id = ${id}::uuid and t.tenant_id = ${tenant}::uuid
        `),
        // sin-inquilino: el rol dueño es el único que borra de "user"; filtra por inquilino a mano.
        db.execute(sql`
          with borrado as (
            delete from public."user" u
            using public.users t
            where u.id = t.id
              and t.id = ${id}::uuid
              and t.tenant_id = ${tenant}::uuid
              and t.dado_de_baja_en is not null
              and t.id <> ${user.id}::uuid
              and exists (select 1 from ${actorVivo})
              and (t.role <> 'owner' or exists (select 1 from ${actorVivo} and a.role = 'owner'))
              and not ${entraPorSso}
              and not ${esOperador}
              and not ${retiene !== null}::boolean
            returning u.id, u.email, t.role
          ), asiento as (
            insert into public.audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload)
            select ${tenant}::uuid, ${user.id}::uuid, ${AuditEvent.USER_DELETED}::text, 'user', b.id::text,
                   jsonb_build_object('rol', b.role, 'huella', ${huellaDeCorreo(tenant, sql`b.email`)})
            from borrado b
          )
          select id, role from borrado
        `),
      ]);
    } catch (e) {
      if (codigoPg(e) === "23503") throw new AppError("CONFLICT", t("usuarios.eliminar.referencias"));
      throw e;
    }

    const borrado = firstRow(filasDe<{ role: string }>(lote[2]));
    if (!borrado) {
      const previa = firstRow(filasDe<Previa>(lote[1]));
      if (!previa) throw new AppError("NOT_FOUND");
      if (!previa.actor_rol) throw new AppError("FORBIDDEN_ROLE");
      if (!previa.de_baja) throw new AppError("CONFLICT", t("usuarios.eliminar.activo"));
      if (retiene) throw new AppError("CONFLICT", t(retiene === "asignados" ? "usuarios.eliminar.casos" : "usuarios.eliminar.firmo"));
      if (previa.sso) throw new AppError("CONFLICT", t("usuarios.eliminar.sso"));
      if (previa.operador) throw new AppError("CONFLICT", t("usuarios.eliminar.operador"));
      if (previa.role === "owner" && previa.actor_rol !== "owner") {
        throw new AppError("FORBIDDEN_ROLE", t("usuarios.eliminar.owner"));
      }
      throw new AppError("FORBIDDEN_ROLE");
    }

    // Las sesiones se fueron con la cuenta (cascada): no hay nada que cerrar. Esta instancia olvida la fila ya; las demás, al vencer su caché (30 s).
    olvidarFilaDeUsuario(id);
    await espejarSinFallar(tenant);

    return ok({ eliminado: id });
  } catch (e) {
    return err(e);
  }
}
