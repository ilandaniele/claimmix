import { esPlanPro } from "@/core/billing/plan-pro";
import { AppError } from "@/lib/errors";
import type { RoleContext } from "@/lib/auth/require-role";

/**
 * Va después de `requireRole`. El plan sale de la fila de la sesión, nunca
 * del pedido: lo que mande el cliente no abre nada.
 */
export function exigirPlanPro(ctx: Pick<RoleContext, "userRow">): void {
  if (!esPlanPro(ctx.userRow.plan)) throw new AppError("PLAN_REQUERIDO");
}
