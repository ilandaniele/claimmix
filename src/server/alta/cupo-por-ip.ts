/**
 * El cupo de espacios nuevos por día y por red, el mismo para las dos puertas que
 * crean uno: /alta (Google) y /alta/correo (el enlace del mail). Si una sola lo
 * toma, la otra es el camino que usa quien quiere esquivarlo.
 *
 * Se toma justo antes de la función de la base y se devuelve si ese intento no
 * dejó un espacio: lo que se libera es SÓLO lo que esta llamada tomó.
 */

import "server-only";

import { entero } from "@/lib/entero";
import { logger } from "@/lib/observability/logger";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { liberarCupo, rateLimit, type RateLimitResult } from "@/lib/rate-limit/index";

const DIA_MS = 24 * 60 * 60_000;

/** Cuántos espacios por día y por red (/56 en IPv6). */
const topeDeAltaPorIp = () => entero("ALTA_TOPE_IP_DIA", 3, 1, 100);

export async function tomarCupoDeAlta(ip: string): Promise<{ clave: string; cupo: RateLimitResult }> {
  const clave = claveDeCupo("alta:ip", ip);
  const cupo = await rateLimit(clave, { limit: topeDeAltaPorIp(), windowMs: DIA_MS, fallaCerrada: true });
  return { clave, cupo };
}

export async function soltarCupoDeAlta(clave: string, ventana: number): Promise<void> {
  try {
    await liberarCupo(clave, DIA_MS, ventana);
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.cupo_no_liberado");
  }
}
