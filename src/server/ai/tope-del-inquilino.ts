import "server-only";

import { AppError } from "@/lib/errors";
import type { TranslationKey } from "@/lib/i18n";
import { iaFrenadaAProposito } from "@/lib/topes";
import type { BudgetCheckResult } from "@/server/ai/budget";

/*
 * Lo que del tope que saltó puede ver el inquilino. El `reason` del mensual trae el gasto del proyecto
 * entero, sumado entre inquilinos («$84.12 / $200»), así que ni el historial ni el 429 lo llevan; los
 * demás motivos traen cifras del propio inquilino o de la persona, o textos fijos.
 */

/** Un motivo ya guardado, para mostrarlo: las filas viejas del mensual llevan ese gasto en el texto. */
export function motivoSinGastoDelProyecto(reason: string): string {
  return reason.startsWith("Presupuesto mensual de IA agotado (") ? "budget_exceeded" : reason;
}

/** El motivo que se guarda en el historial del inquilino. */
export function motivoParaElHistorial(tope: BudgetCheckResult): string | undefined {
  if (iaFrenadaAProposito(tope.motivo)) return "ia_pausada";
  return tope.motivo === "mensual" ? "budget_exceeded" : tope.reason;
}

/** El 429 para quien pidió: con la IA pausada a propósito, el mensaje que dice cómo se prende, marcado con `frenada`. */
export function errorDelTope(tope: BudgetCheckResult, t: (clave: TranslationKey) => string): AppError {
  if (iaFrenadaAProposito(tope.motivo)) {
    return new AppError("AI_BUDGET_EXCEEDED", t("configuracion.capAyudaFrenada"), { frenada: true });
  }
  return new AppError("AI_BUDGET_EXCEEDED", tope.motivo === "mensual" ? t("asistente.presupuestoMensual") : tope.reason);
}
