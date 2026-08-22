/**
 * ¿Esta llamada viene de adentro?
 *
 * Tres rutas internas —el worker de extracción, el reproceso de casos sin
 * clasificar y el alta del watch de Gmail— confiaban en un header
 * `X-Internal-Worker: true` para saberlo. Un header no es un secreto: lo puede
 * mandar cualquiera, y no hay nada en el borde que lo saque. El matcher de
 * `proxy.ts` ni siquiera corre sobre `/api`, así que la "segunda capa" que los
 * comentarios daban por hecha no existía. El header era la única puerta, y
 * estaba abierta.
 *
 * En Vercel las funciones se llaman entre sí por la URL pública, no por la red
 * interna, así que "viene de adentro" no se puede deducir del origen. Tiene que
 * probarse con algo que sólo adentro se conoce: CRON_SECRET, que ya vive en el
 * deploy y que estas mismas rutas ya aceptaban por la otra mitad de su lógica.
 *
 * Falla cerrado: sin CRON_SECRET configurado, nadie entra por acá.
 */

import "server-only";

import { timingSafeStringEqual } from "@/lib/security/compare";

export function isInternalRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return timingSafeStringEqual(request.headers.get("authorization"), `Bearer ${secret}`);
}

/**
 * El header que manda un llamador interno. Un solo lugar para armarlo, así el
 * secreto viaja igual desde todos y no se cuela un `X-Internal-Worker` nuevo.
 */
export function internalAuthHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Que reviente acá, del lado de quien llama, y no que mande una llamada que
    // va a rebotar con 401 sin explicación.
    throw new Error("CRON_SECRET no está configurado; el worker interno no puede autenticarse");
  }
  return { Authorization: `Bearer ${secret}` };
}
