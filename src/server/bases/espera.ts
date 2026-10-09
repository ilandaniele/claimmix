/**
 * Qué ve quien espera a que su base esté lista (/preparando) y cuándo puede
 * pedir que se vuelva a preparar. La pantalla y la acción de reintentar leen la
 * misma regla: si cada una la escribiera por su cuenta, el botón y la acción
 * podrían discrepar.
 *
 * Sin imports de servidor a propósito: es una cuenta sobre dos datos de la fila.
 * Una fecha que no se conoce cuenta como vencida: ofrecer el botón no rompe nada, esperar sin fin sí.
 */

import type { FilaUsuario } from "@/lib/auth/fila-de-usuario-cacheada";

/** Pasado este plazo desde que se pidió la base, `creando` ya no es «tarda un rato»: se ofrece reintentar. */
export const MINUTOS_PARA_REINTENTAR = 15;

export type VistaDeBase = "lista" | "esperando" | "reintentable" | "borrada";

/**
 * `base` null es un inquilino sin fila en `tenant_bases`: la preparación nunca
 * llegó a registrarse. Se espera igual que `creando` (puede estar en camino) y,
 * pasado el plazo, se deja reintentar.
 */
export function vistaDeBase(
  { base, baseDesde }: Pick<FilaUsuario, "base" | "baseDesde">,
  ahora: number = Date.now(),
): VistaDeBase {
  if (base === "lista") return "lista";
  if (base === "borrada") return "borrada";
  if (base === "fallida") return "reintentable";
  const vencida = baseDesde === null || ahora - baseDesde.getTime() > MINUTOS_PARA_REINTENTAR * 60_000;
  return vencida ? "reintentable" : "esperando";
}
