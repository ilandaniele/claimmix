/**
 * Los tres números de arriba de la bandeja, en un solo lugar.
 *
 * Estaban escritos a mano en la pantalla contra el vocabulario VIEJO, el del
 * flujo simulado. Es el mismo defecto que ya se arregló en las métricas: con
 * 43 casos en `requiere_especialista` la baldosa «Escalados» decía 0 y
 * aclaraba «Ninguno abierto», y los que llegaron a `listo_para_core` no
 * aparecían en ninguna baldosa. Las pestañas de abajo sí muestran los trece
 * estados, así que la pantalla se contradecía consigo misma.
 *
 * Recibe las filas del GROUP BY ya contadas y no habla con la base: quién
 * puede pedirlas es decisión del borde, y así esto se prueba sin montar
 * nada.
 */

import {
  ESTADOS_ESCALADO,
  ESTADOS_ESPERANDO_AL_DENUNCIANTE,
  ESTADOS_RESUELTOS,
  type CaseStatus,
} from "./fsm";

export interface KpisDeLaBandeja {
  escalados: number;
  esperando: number;
  resueltos: number;
}

export function kpisDeLaBandeja(
  porEstado: ReadonlyArray<{ status: string; count: number }>
): KpisDeLaBandeja {
  const cuenta = new Map<string, number>(porEstado.map((r) => [r.status, r.count]));

  // Un estado sin casos no vuelve del GROUP BY: cuenta 0, no rompe.
  const sumar = (estados: ReadonlySet<CaseStatus>) =>
    [...estados].reduce((acc, s) => acc + (cuenta.get(s) ?? 0), 0);

  return {
    escalados: sumar(ESTADOS_ESCALADO),
    esperando: sumar(ESTADOS_ESPERANDO_AL_DENUNCIANTE),
    resueltos: sumar(ESTADOS_RESUELTOS),
  };
}
