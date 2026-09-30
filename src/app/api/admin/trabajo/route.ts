/**
 * /api/admin/trabajo — cómo trabaja el equipo (B9, B10, B11, B13).
 *
 * GET   las cuatro configuraciones guardadas, los valores por defecto y la carga
 *       de cada persona del equipo.
 * PATCH { campo, valor } guarda una: reglas_asignacion, plazos, plan_por_tipo o
 *       pesos_puntaje. `valor: null` vuelve al valor por defecto. Lo valida el
 *       esquema del núcleo, y queda auditado con quién lo cambió.
 *
 * Sólo un admin, sólo de su inquilino. Nada de esto sale al asegurado.
 */

import { NextRequest } from "next/server";

import { ok, err } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/require-admin";
import { AppError } from "@/lib/errors";
import { CambioDeTrabajoSchema, guardarTrabajo, leerTrabajo } from "@/server/cases/trabajo-del-equipo";

export async function GET() {
  try {
    const { userRow } = await requireAdmin();
    return ok(await leerTrabajo({ tenantId: userRow.tenant_id }));
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { user, userRow } = await requireAdmin();
    const parsed = CambioDeTrabajoSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      const problema = parsed.error.issues[0];
      const donde = problema?.path.length ? `${problema.path.join(".")}: ` : "";
      throw new AppError("VALIDATION_FAILED", `${donde}${problema?.message ?? "Cuerpo inválido."}`);
    }

    const cambio = await guardarTrabajo({ tenantId: userRow.tenant_id }, user.id, parsed.data);
    if (!cambio) throw new AppError("NOT_FOUND");

    return ok({ campo: parsed.data.campo, valor: parsed.data.valor });
  } catch (e) {
    return err(e);
  }
}
