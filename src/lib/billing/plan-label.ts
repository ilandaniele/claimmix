import type { TranslationKey } from "@/lib/i18n";
import { PLANS, type Plan } from "@/lib/billing/plans";

const CLAVES: Record<Plan, TranslationKey> = {
  piloto: "plan.piloto",
  operativo: "plan.operativo",
  profesional: "plan.profesional",
  corporativo: "plan.corporativo",
  enterprise: "plan.enterprise",
};

// `tenants.plan` is text, not an enum: unknown plan → stored label.
export function nombreDePlan(
  plan: string,
  etiqueta: string,
  t: (key: TranslationKey) => string
): string {
  return (PLANS as readonly string[]).includes(plan) ? t(CLAVES[plan as Plan]) : etiqueta;
}
