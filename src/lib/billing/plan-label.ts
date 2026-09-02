/**
 * El nombre comercial de un plan, en el idioma de quien mira.
 *
 * Vive acá y no en `plans.ts` a propósito. Ese archivo es la lista de precios y
 * la aritmética de la factura, y está deliberadamente libre de `server-only`, de
 * base y de I/O: es la parte que nunca puede estar mal, así que es una función
 * pura sobre números y se prueba entera sin levantar nada. Meterle el
 * diccionario adentro para escribir «Professional» sería pagar ese precio por
 * una etiqueta.
 *
 * Las pantallas ya tienen las dos cosas —el CÓDIGO del plan (`piloto`) y la
 * etiqueta guardada (`Piloto`)—, así que el código alcanza para elegir la clave
 * y la etiqueta queda como red: la columna `tenants.plan` es `text`, no un
 * enum, así que un plan que no esté en el catálogo es posible y no tiene que
 * dibujar un hueco.
 */
import type { TranslationKey } from "@/lib/i18n";
import { PLANS, type Plan } from "@/lib/billing/plans";

const CLAVES: Record<Plan, TranslationKey> = {
  piloto: "plan.piloto",
  operativo: "plan.operativo",
  profesional: "plan.profesional",
  corporativo: "plan.corporativo",
  enterprise: "plan.enterprise",
};

/**
 * @param plan      El código del plan, tal como está en `tenants.plan`.
 * @param etiqueta  Lo que se mostraba antes, para un plan fuera del catálogo.
 */
export function nombreDePlan(
  plan: string,
  etiqueta: string,
  t: (key: TranslationKey) => string
): string {
  return (PLANS as readonly string[]).includes(plan)
    ? t(CLAVES[plan as Plan])
    : etiqueta;
}
