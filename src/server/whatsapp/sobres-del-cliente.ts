/**
 * Los sobres cifrados de la WABA propia de un cliente: el token de su usuario de
 * sistema, el PIN de su número y el App Secret de su app. Los cifra el alta (`waba-propia.ts`) y los abren
 * quien manda (`numeros.ts`), el panel del operador y la revisión de salud, así
 * que el formato del AAD vive en un solo lugar y por debajo de todos ellos.
 */

import "server-only";
import { createHmac } from "node:crypto";
import { nombreDelError } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { cifrarConClave, descifrar } from "@/lib/security/cifrado";

/** Ata el token a su espacio y a su WABA: copiado a la fila de otro cliente no abre. */
export const aadDelToken = (tenantId: string, wabaId: string) => `wa:${tenantId}:${wabaId}`;
export const aadDelPin = (tenantId: string, wabaId: string) => `wa-pin:${tenantId}:${wabaId}`;
/** Ata el App Secret a su espacio y a su App ID. */
export const aadDelSecreto = (tenantId: string, appId: string) => `wa-secreto:${tenantId}:${appId}`;

/** El App Secret del cliente, en el sobre versionado `wa1`. Lo abre `abrirSobre` con `aadDelSecreto`. */
export const cerrarSecreto = (secreto: string, tenantId: string, appId: string): string =>
  cifrarConClave("wa1", secreto, aadDelSecreto(tenantId, appId));

/**
 * El `appsecret_proof` de Graph: el HMAC-SHA256 del token con el App Secret, en hexadecimal.
 * Vive acá y no en `app-del-cliente.ts` porque ése importa `numeros.ts`, que también lo necesita.
 */
export function pruebaDelSecreto(token: string, secreto: string): string {
  return createHmac("sha256", secreto).update(token).digest("hex");
}

/** Un sobre que no abre (la clave cambió, o es de otra fila) vale lo mismo que no tenerlo: se vuelve a conectar. */
export function abrirSobre(sobre: string | null, aad: string): string | null {
  if (!sobre) return null;
  try {
    return descifrar(sobre, "Invalid encrypted payload", aad);
  } catch (e) {
    logger.error({ error: nombreDelError(e) }, "alta.waba_descifrado_fallo");
    return null;
  }
}
