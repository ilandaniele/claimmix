import { enPrueba } from "@/lib/billing/plans";
import { AppError } from "@/lib/errors";
import type { RoleContext } from "@/lib/auth/require-role";

/**
 * Va después de `requireRole`, en lo que cuesta plata o toca el modelo de
 * verdad: entrenar. El estado del espacio sale de la fila de la sesión, nunca
 * del pedido: lo que mande el cliente no abre nada.
 */
export function exigirSinPrueba(ctx: Pick<RoleContext, "userRow">): void {
  if (enPrueba(ctx.userRow)) throw new AppError("PLAN_SIN_ENTRENAMIENTO");
}
