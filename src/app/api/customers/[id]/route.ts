/**
 * PATCH /api/customers/:id — edita los datos de un cliente a mano (B16).
 *
 * Lo que no viene queda igual; un campo vacío borra el dato (menos el nombre,
 * que no se puede dejar en blanco). El DNI no se cambia: es con lo que el
 * padrón reconoce a la persona, y cambiarlo a mano es dar de alta a otra.
 *
 * Auth: quienes editan el padrón. El inquilino sale de la sesión: la consulta
 * corre acotada por RLS, así que un `id` de otro inquilino es «no existe».
 */

import { type NextRequest } from "next/server";
import { z } from "zod";

import { ClienteCambioSchema } from "@/core/padron/manual";
import { enTenant } from "@/data/scope";
import { ok, err } from "@/lib/api/respond";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { firstRow } from "@/lib/db/helpers";
import { camposPresentes, entrarAEscribir, leerCuerpo, rechazo } from "@/server/padron/escritura";
import { cambiosDelCliente, consultaCambioCliente } from "@/server/padron/manual";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.guid() });

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { userRow, t } = await entrarAEscribir();
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) return rechazo(t, ["cliente_no_existe"], "NOT_FOUND");

    const cuerpo = await leerCuerpo(request, ClienteCambioSchema, t);
    if (!cuerpo.ok) return cuerpo.respuesta;
    const cambios = cambiosDelCliente(cuerpo.datos);
    if (!cambios) return rechazo(t, ["sin_cambios"]);

    const tenantId = userRow.tenant_id;
    const fila = firstRow(await enTenant({ tenantId }, (db) => consultaCambioCliente(db, params.data.id, cambios)));
    if (!fila) return rechazo(t, ["cliente_no_existe"], "NOT_FOUND");

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.CLIENTE_CAMBIO,
      target_type: "customer",
      target_id: fila.id,
      payload: { campos: camposPresentes(cuerpo.datos) },
    });
    return ok({ id: fila.id });
  } catch (e) {
    return err(e);
  }
}
