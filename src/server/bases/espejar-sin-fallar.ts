/**
 * Espeja a un inquilino después de una escritura que ya salió bien en control.
 * La copia nunca hace fallar la operación: si no entra queda pendiente y el barrido
 * (`espejarTodas`) la levanta. Devuelve false si quedó pendiente, para quien deba avisarlo.
 *
 * Un reintento en el acto: si no entra la copia queda vieja hasta el próximo barrido,
 * que tarda horas. Con 3D000 no reintenta, porque la base todavía no existe o ya no está.
 * Lo pagan todos los que llaman, no sólo el admin de usuarios: con la base del cliente
 * caída, el login por SSO y cada vuelta del bucle de `bajaDeWaba` hacen dos intentos en
 * vez de uno, y si el error llega tarde (una conexión colgada) la espera se duplica.
 *
 * El mensaje del error lleva las filas (correos incluidos): sólo se anota el código.
 */

import "server-only";

import { esBaseInexistente } from "@/data/bases";
import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";

import { espejar } from "./espejo";

export async function espejarSinFallar(tenantId: string): Promise<boolean> {
  let error: unknown;
  for (let intento = 0; intento < 2; intento++) {
    try {
      await espejar(tenantId);
      return true;
    } catch (e) {
      error = e;
      if (esBaseInexistente(e)) break;
    }
  }
  logger.warn({ tenantId, detalle: codigoPg(error) }, "bases.espejo_pendiente");
  return false;
}
