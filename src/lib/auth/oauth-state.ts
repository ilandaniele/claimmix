/**
 * El `state` de la vuelta de OAuth, y el nonce que lo hace no falsificable.
 *
 * ── Qué protegía antes y qué no ─────────────────────────────────────────────
 *
 * El `state` era `base64(JSON({ tenantId, userId }))` y el callback comprobaba
 * que esos dos coincidieran con la sesión. Eso alcanza para que nadie enganche
 * una casilla a la aseguradora de OTRO: habría que estar logueado como esa
 * persona.
 *
 * Lo que NO cubría es el caso clásico de CSRF en OAuth. Un admin ve el padrón
 * de su aseguradora en `/api/admin/users`, así que conoce el `userId` de sus
 * colegas. Con eso podía armar un `state` válido para un colega, conseguir un
 * `code` de SU PROPIA casilla de Gmail, y lograr que el colega abriera la URL
 * del callback. Resultado: la casilla del atacante queda enganchada a la
 * aseguradora, y todos los siniestros que entran pasan por ahí.
 *
 * ── La defensa ─────────────────────────────────────────────────────────────
 *
 * Un valor al azar que viaja por dos caminos: adentro del `state` —que va y
 * vuelve por Google— y en una cookie propia, `HttpOnly` y de vida corta. El
 * callback exige que los dos coincidan.
 *
 * Es el patrón de doble envío que describe el manual. Funciona porque un
 * atacante puede fabricar el `state` pero no puede escribirle una cookie al
 * navegador de la víctima para ese dominio.
 *
 * La cookie se borra al usarse: un `state` sirve una sola vez.
 */

import "server-only";

import { randomBytes } from "crypto";

export const COOKIE_ESTADO_OAUTH = "gmail_oauth_state";

/**
 * Diez minutos.
 *
 * Es lo que puede tardar alguien en elegir cuenta, revisar los permisos y
 * aceptar. Más que eso ya no es una autorización en curso.
 */
export const ESTADO_OAUTH_DURA_SEGUNDOS = 600;

export interface EstadoOAuth {
  tenantId: string;
  userId: string;
  nonce: string;
}

export function nuevoNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function codificarEstado(estado: EstadoOAuth): string {
  return Buffer.from(JSON.stringify(estado), "utf8").toString("base64url");
}

export function decodificarEstado(state: string | null): Partial<EstadoOAuth> {
  if (!state) return {};
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as Partial<EstadoOAuth>;
  } catch {
    return {};
  }
}

/**
 * ¿El `state` que volvió es el que mandamos, para esta sesión?
 *
 * @param esperado el nonce que quedó en la cookie del navegador.
 */
export function estadoEsValido(
  estado: Partial<EstadoOAuth>,
  sesion: { tenantId: string; userId: string },
  esperado: string | undefined
): boolean {
  if (!esperado || !estado.nonce) return false;
  if (estado.tenantId !== sesion.tenantId) return false;
  if (estado.userId !== sesion.userId) return false;
  return comparacionConstante(estado.nonce, esperado);
}

/**
 * Comparar sin filtrar por tiempo.
 *
 * Acá el nonce lo eligió el servidor y no hay un oráculo evidente que
 * aprovechar, pero comparar secretos con `===` es la clase de detalle que se
 * copia de un lado a otro. Que el patrón del repo sea siempre el mismo vale más
 * que el ahorro.
 */
function comparacionConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let distinto = 0;
  for (let i = 0; i < a.length; i++) {
    distinto |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return distinto === 0;
}
