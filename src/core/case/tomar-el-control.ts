/**
 * Si una persona puede tomar el control de un caso de WhatsApp que el agente
 * dejó a medias (video 5e). D-F2: sólo con el agente terminado del todo —sin
 * corrida pendiente, sin reserva viva—, porque tomar el control mientras el
 * agente sigue escribiendo pisaría su respuesta.
 *
 * No abre un endpoint ni un estado nuevo: el PATCH sigue siendo el de
 * siempre, hacia `requiere_especialista`. La guarda del servidor está en
 * `patchCase`; esto es sólo lo que decide si se muestra el botón.
 */
import { esPlanPro } from "@/core/billing/plan-pro";
import { reservaViva } from "@/core/case/reserva-de-extraccion";

export function puedeTomarElControl(i: {
  puedeCambiarEstado: boolean;
  plan: string | null;
  channel: string;
  status: string;
  extractionPending: boolean;
  extractionLeaseAt: string | null;
  ahora: Date;
}): boolean {
  if (!i.puedeCambiarEstado) return false;
  if (i.channel !== "whatsapp" && i.channel !== "whatsapp_sim") return false;
  if (!esPlanPro(i.plan)) return false;
  if (i.status !== "info_faltante" && i.status !== "confirmacion_pendiente") return false;
  if (i.extractionPending) return false;
  if (reservaViva(i.extractionLeaseAt, i.ahora)) return false;
  return true;
}
