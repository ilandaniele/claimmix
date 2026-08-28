/**
 * GET /api/metricas — los KPIs del inquilino.
 *
 * El cálculo vive en `@/server/metrics/kpis`, compartido con la pantalla.
 */

import { requireRole, ALL_ROLES } from "@/lib/auth/require-role";
import { ok, err } from "@/lib/api/respond";
import { getTenantKpis } from "@/server/metrics/kpis";

/*
 * Este handler tenía las nueve consultas y la agregación escritas de nuevo, y
 * las dos copias ya habían divergido: para un `claim_type` nulo, acá se
 * agrupaba bajo la clave "null" y en la pantalla se descartaba, así que esta
 * API y la pantalla que dice servir devolvían `by_type` distintos. Gana el
 * comportamiento de la pantalla, que es el que alguien mira.
 *
 * De paso hereda la agregación en SQL: traía la tabla `cases` entera tres
 * veces para contar en JavaScript.
 */
export async function GET() {
  try {
    const { userRow } = await requireRole(...ALL_ROLES);
    return ok(await getTenantKpis({ tenantId: userRow.tenant_id }));
  } catch (e) {
    return err(e);
  }
}
