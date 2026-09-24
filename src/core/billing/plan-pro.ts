/**
 * Qué planes abren las funciones del Plan Pro.
 *
 * Lo leen la guarda del servidor (`exigirPlanPro`) y el layout, que a la
 * barra le pasa sólo el booleano.
 */
import type { Plan } from "@/lib/billing/plans";

const PLANES_PRO: readonly Plan[] = ["profesional", "corporativo", "enterprise"];

/** Un plan desconocido o ausente cierra: no se regala el Pro por un dato roto. */
export function esPlanPro(plan: string | null | undefined): boolean {
  return (PLANES_PRO as readonly string[]).includes(plan ?? "");
}
