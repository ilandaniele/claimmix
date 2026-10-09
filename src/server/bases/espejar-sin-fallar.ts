/**
 * Espeja a un inquilino después de una escritura que ya salió bien en control.
 * La copia nunca hace fallar la operación: si no entra queda pendiente y el barrido
 * (`espejarTodas`) la levanta. Devuelve false si quedó pendiente, para quien deba avisarlo.
 *
 * El mensaje del error lleva las filas (correos incluidos): sólo se anota el código.
 */

import "server-only";

import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";

import { espejar } from "./espejo";

export async function espejarSinFallar(tenantId: string): Promise<boolean> {
  try {
    await espejar(tenantId);
    return true;
  } catch (e) {
    logger.warn({ tenantId, detalle: codigoPg(e) }, "bases.espejo_pendiente");
    return false;
  }
}
