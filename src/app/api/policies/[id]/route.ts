/**
 * PATCH /api/policies/:id — edita ramo, estado, vigencia y prima de una póliza
 * a mano (B16).
 *
 * Lo que no viene queda igual; una fecha o la prima vacías se borran. La
 * vigencia se manda entera (las dos fechas) o no se manda. El número de póliza
 * y el titular no se cambian: una póliza que pasa a otro cliente es otra póliza.
 *
 * Auth: quienes editan el padrón. El inquilino sale de la sesión: la consulta
 * corre acotada por RLS, así que un `id` de otro inquilino es «no existe».
 */

import { type NextRequest } from "next/server";
import { z } from "zod";

import { PolizaCambioSchema } from "@/core/padron/manual";
import { enTenant } from "@/data/scope";
import { ok, err } from "@/lib/api/respond";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { firstRow } from "@/lib/db/helpers";
import { camposPresentes, entrarAEscribir, leerCuerpo, rechazo } from "@/server/padron/escritura";
import { cambiosDeLaPoliza, consultaCambioPoliza } from "@/server/padron/manual";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.guid() });

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { userRow, t } = await entrarAEscribir();
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) return rechazo(t, ["poliza_no_existe"], "NOT_FOUND");

    const cuerpo = await leerCuerpo(request, PolizaCambioSchema, t);
    if (!cuerpo.ok) return cuerpo.respuesta;
    const cambios = cambiosDeLaPoliza(cuerpo.datos);
    if (!cambios) return rechazo(t, ["sin_cambios"]);

    const tenantId = userRow.tenant_id;
    const fila = firstRow(await enTenant({ tenantId }, (db) => consultaCambioPoliza(db, params.data.id, cambios)));
    if (!fila) return rechazo(t, ["poliza_no_existe"], "NOT_FOUND");

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.POLIZA_CAMBIO,
      target_type: "policy",
      target_id: fila.id,
      payload: { campos: camposPresentes(cuerpo.datos) },
    });
    return ok({ id: fila.id });
  } catch (e) {
    return err(e);
  }
}
