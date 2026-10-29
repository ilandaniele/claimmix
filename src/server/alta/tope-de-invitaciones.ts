/**
 * Cuántas invitaciones por día puede mandar un espacio. Lo usan la ruta que invita
 * (como tope del cupo) y la pantalla de usuarios (para saber cuántas filas deja
 * armar de una vez): un `route.ts` sólo puede exportar handlers, así que no podía
 * vivir ahí.
 */

import "server-only";

import { enPrueba, type InquilinoEnPrueba } from "@/lib/billing/plans";
import { topeEntero } from "@/lib/topes";

/** Una prueba invita a lo sumo a cinco personas por día. */
const TOPE_EN_PRUEBA = 5;

/** El tope del día, no lo que queda: ya invitado hoy, las últimas filas de un lote pueden chocar con el cupo. */
export function topeDeInvitacionesDelDia(inquilino: InquilinoEnPrueba): number {
  const tope = topeEntero("ALTA_TOPE_INVITACIONES_DIA");
  return enPrueba(inquilino) ? Math.min(tope, TOPE_EN_PRUEBA) : tope;
}
