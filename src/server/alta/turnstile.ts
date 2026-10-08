/**
 * Cloudflare Turnstile: el desafío anti-bots de /registro, SÓLO para el camino
 * por correo.
 *
 * Existe únicamente si están las dos claves (TURNSTILE_SITE_KEY y
 * TURNSTILE_SECRET_KEY). Con una sola, o con ninguna, no hay widget, no se llama
 * a Cloudflare y la CSP queda como estaba: media configuración no tiene que
 * dejar abierto un origen ni exigir un desafío que nadie puede resolver.
 *
 * Con las dos puestas, cualquier falla de la verificación —respuesta negativa,
 * Cloudflare caído, plazo vencido— cuenta como no pasada. Un desafío que se
 * saltea cuando no contesta no frena a nadie.
 *
 * No importa `server-only` porque la CSP (proxy.ts) también pregunta si existe;
 * la clave secreta sólo se lee acá y nunca sale en una respuesta.
 */

import { isIP } from "node:net";

const URL_DE_VERIFICACION = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const PLAZO_MS = 5_000;

export interface ClavesDeTurnstile {
  sitio: string;
  secreta: string;
}

/** Las dos claves, o null si falta cualquiera. */
export function clavesDeTurnstile(): ClavesDeTurnstile | null {
  const sitio = process.env.TURNSTILE_SITE_KEY?.trim();
  const secreta = process.env.TURNSTILE_SECRET_KEY?.trim();
  return sitio && secreta ? { sitio, secreta } : null;
}

/**
 * ¿Pasó el desafío? Sin claves no hay desafío y pasa, sin llamar a nadie. Con
 * claves, sólo pasa si Cloudflare lo confirma.
 */
export async function verificarTurnstile(respuesta: unknown, ip: string): Promise<boolean> {
  const claves = clavesDeTurnstile();
  if (!claves) return true;
  if (typeof respuesta !== "string" || !respuesta) return false;

  try {
    const cuerpo = new URLSearchParams({ secret: claves.secreta, response: respuesta });
    // Sólo una IP de verdad: «unknown» no es una dirección y Cloudflare la rechazaría.
    if (isIP(ip) !== 0) cuerpo.set("remoteip", ip);
    const r = await fetch(URL_DE_VERIFICACION, {
      method: "POST",
      body: cuerpo,
      signal: AbortSignal.timeout(PLAZO_MS),
    });
    if (!r.ok) return false;
    const resultado = (await r.json()) as { success?: unknown };
    return resultado.success === true;
  } catch {
    return false;
  }
}
