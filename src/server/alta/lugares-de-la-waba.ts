/**
 * Cuántos números le quedan a la WABA de la plataforma, para la tarjeta de /admin/altas.
 *
 * Es el mismo conteo que decide `sin_lugar` en `numero-automatico.ts`: números por
 * WABA contra ALTA_NUMEROS_MAXIMOS_WABA, no contra el tope de Meta por portfolio.
 * Una sola recorrida de Graph y ninguna consulta a la base. Si Graph no contestó o
 * la lista quedó a medias no hay dato —un conteo a medias no es un conteo—, y
 * tampoco tira: la página sigue sin la tarjeta.
 */

import "server-only";
import { topeEntero } from "@/lib/topes";
import { credencialDelEntorno } from "@/server/whatsapp/numeros";
import { recorrerLaWaba } from "@/server/whatsapp/verificar-en-meta";

export interface LugaresDeLaWaba {
  usados: number;
  tope: number;
  libres: number;
}

export async function lugaresDeLaWaba(): Promise<LugaresDeLaWaba | null> {
  try {
    const cred = credencialDelEntorno();
    if (!cred?.wabaId) return null;
    const r = await recorrerLaWaba(cred.wabaId, "id", cred.accessToken);
    if (!r?.completa) return null;
    const usados = r.filas.length;
    const tope = topeEntero("ALTA_NUMEROS_MAXIMOS_WABA");
    return { usados, tope, libres: Math.max(0, tope - usados) };
  } catch {
    return null;
  }
}
