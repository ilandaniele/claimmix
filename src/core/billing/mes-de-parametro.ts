import { resolveBillingPeriod } from "@/lib/billing/period";

// "?month=basura" no puede tirar abajo /admin/cartera: un mes con forma
// inválida o fuera del rango que acepta `resolveBillingPeriod` usa el mes en
// curso en vez de reventar.
export function mesDeParametro(raw: string | undefined, ahora: Date): string {
  if (raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) && resolveBillingPeriod(raw, ahora) !== null) return raw;
  return `${ahora.getUTCFullYear()}-${String(ahora.getUTCMonth() + 1).padStart(2, "0")}`;
}
