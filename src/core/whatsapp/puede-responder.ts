/**
 * Si una persona puede responder un caso por WhatsApp, y por qué no si no.
 *
 * Pura: la usan tanto el GET de mensajes (para mostrar el estado) como el
 * POST que responde (para exigirlo de nuevo del lado del servidor). Cuatro
 * condiciones, en este orden de motivo si falla más de una: plan, rol, canal,
 * agente activo, ventana.
 */
import { esPlanPro } from "@/core/billing/plan-pro";
import { CASE_EDITOR_ROLES } from "@/lib/auth/roles";
import { puedeArrancar } from "@/core/case/estados-de-arranque";

/** Meta cierra la ventana de servicio al cliente a las 24 h del último entrante. */
export const VENTANA_WHATSAPP_MS = 24 * 60 * 60 * 1000;

export type MotivoSinRespuesta = "plan" | "rol" | "canal" | "agente_activo" | "ventana";

export interface EstadoDeRespuesta {
  habilitada: boolean;
  motivo: MotivoSinRespuesta | null;
  vence_en: string | null;
}

export function estadoDeRespuesta(i: {
  plan: string | null;
  role: string;
  channel: string;
  status: string;
  ultimoEntrante: string | null;
  ahora: Date;
}): EstadoDeRespuesta {
  if (!esPlanPro(i.plan)) return { habilitada: false, motivo: "plan", vence_en: null };
  if (!(CASE_EDITOR_ROLES as readonly string[]).includes(i.role)) {
    return { habilitada: false, motivo: "rol", vence_en: null };
  }
  if (i.channel !== "whatsapp" && i.channel !== "whatsapp_sim") {
    return { habilitada: false, motivo: "canal", vence_en: null };
  }
  if (puedeArrancar(i.status)) return { habilitada: false, motivo: "agente_activo", vence_en: null };

  if (!i.ultimoEntrante) return { habilitada: false, motivo: "ventana", vence_en: null };
  const vence = new Date(new Date(i.ultimoEntrante).getTime() + VENTANA_WHATSAPP_MS);
  if (vence.getTime() <= i.ahora.getTime()) {
    return { habilitada: false, motivo: "ventana", vence_en: null };
  }
  return { habilitada: true, motivo: null, vence_en: vence.toISOString() };
}
