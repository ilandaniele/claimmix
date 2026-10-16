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
 * Cloudflare caído, plazo vencido— cuenta como no pasada, con el motivo para
 * quien lo registre. Un desafío que se saltea cuando no contesta no frena a nadie.
 *
 * No importa `server-only` ni el logger (que lo trae) porque la CSP (proxy.ts)
 * también pregunta si existe; la clave secreta sólo se lee acá y nunca sale en
 * una respuesta.
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

export type ResultadoDeTurnstile =
  | { paso: true }
  | {
      paso: false;
      motivo: "sin_respuesta" | "rechazada" | "cloudflare_error" | "cloudflare_no_contesta";
      /** Los `error-codes` de Cloudflare, sólo los que tienen la forma de un código. */
      codigos?: string[];
    };

const FORMA_DE_CODIGO = /^[a-z0-9-]{1,40}$/;
const MAXIMO_DE_CODIGOS = 5;

/** Lo único que se deja salir de `error-codes`: textos con forma de código, y pocos. */
function codigosDe(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor
    .filter((c): c is string => typeof c === "string" && FORMA_DE_CODIGO.test(c))
    .slice(0, MAXIMO_DE_CODIGOS);
}

/**
 * ¿Pasó el desafío? Sin claves no hay desafío y pasa, sin llamar a nadie. Con
 * claves, sólo pasa si Cloudflare lo confirma; si no, dice por qué (nunca la
 * respuesta, la clave ni la IP).
 */
export async function verificarTurnstile(respuesta: unknown, ip: string): Promise<ResultadoDeTurnstile> {
  const claves = clavesDeTurnstile();
  if (!claves) return { paso: true };
  if (typeof respuesta !== "string" || !respuesta) return { paso: false, motivo: "sin_respuesta" };

  const cuerpo = new URLSearchParams({ secret: claves.secreta, response: respuesta });
  // Sólo una IP de verdad: «unknown» no es una dirección y Cloudflare la rechazaría.
  if (isIP(ip) !== 0) cuerpo.set("remoteip", ip);
  // El plazo cubre también la lectura del cuerpo.
  const plazo = AbortSignal.timeout(PLAZO_MS);

  let r: Response;
  try {
    r = await fetch(URL_DE_VERIFICACION, { method: "POST", body: cuerpo, signal: plazo });
  } catch {
    return { paso: false, motivo: "cloudflare_no_contesta" };
  }
  let cuerpoDeCloudflare: unknown;
  try {
    // Se lee aunque no sea 2xx: una clave mal cargada vuelve con 400 y el código en el cuerpo.
    cuerpoDeCloudflare = await r.json();
  } catch {
    return { paso: false, motivo: plazo.aborted ? "cloudflare_no_contesta" : "cloudflare_error" };
  }
  const resultado = (typeof cuerpoDeCloudflare === "object" && cuerpoDeCloudflare !== null ? cuerpoDeCloudflare : {}) as {
    success?: unknown;
    "error-codes"?: unknown;
  };
  if (r.ok && resultado.success === true) return { paso: true };
  const motivo = r.ok ? "rechazada" : "cloudflare_error";
  const codigos = codigosDe(resultado["error-codes"]);
  return codigos.length > 0 ? { paso: false, motivo, codigos } : { paso: false, motivo };
}
