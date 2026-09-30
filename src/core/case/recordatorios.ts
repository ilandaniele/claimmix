/**
 * Cuándo se le recuerda al denunciante lo que falta (B4).
 *
 * Cada aseguradora elige hasta dos momentos, en horas desde el primer pedido
 * sin respuesta (la ancla). Vacío es apagado. El barrido decide la etapa con
 * esto y la reserva en `case_recordatorios` antes de mandar.
 */

import { z } from "zod";

const HORA_MS = 60 * 60 * 1000;
const HUECO_MINIMO = 24;

export const horasDeRecordatorio = z
  .array(z.number().int().min(24).max(720))
  .max(2)
  .refine((h) => h.every((v, i) => i === 0 || v - h[i - 1] >= HUECO_MINIMO), {
    message: "ascendentes y con al menos 24 h entre una y otra",
  });

/** La etapa más alta ya vencida, empezando en 1, o null si ninguna venció. */
export function etapaVencida(horas: readonly number[], ancla: string | Date, ahora: Date): number | null {
  const pasaron = (ahora.getTime() - new Date(ancla).getTime()) / HORA_MS;
  let etapa: number | null = null;
  horas.forEach((h, i) => {
    if (pasaron >= h) etapa = i + 1;
  });
  return etapa;
}

/** El aviso de cierre ocupa su propia etapa, con una ancla fija: uno por caso. */
export const ETAPA_AVISO_DE_CIERRE = 9;
export const ANCLA_DEL_CIERRE = "1970-01-01T00:00:00Z";

/** Un pedido de menos de 24 h (el reenvío manual, por ejemplo) no se repite. */
export function pedidoReciente(enviado: string | null, ahora: Date): boolean {
  if (!enviado) return false;
  return ahora.getTime() - new Date(enviado).getTime() < 24 * HORA_MS;
}
