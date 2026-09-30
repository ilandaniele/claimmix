/**
 * La clave de /api/v1 (B5): `cmk_<tenantId>_<43 base64url>`. La crea
 * /api/admin/core-sync y la lee `/api/v1/_auth.ts`; el formato y el hash viven
 * acá para que no se separen.
 */

import "server-only";
import { createHash, randomBytes } from "crypto";

/** Lo que es del inquilino, o se muestra una sola vez: ni el navegador ni un proxy lo guardan. */
export const SIN_CACHE = { "Cache-Control": "no-store" } as const;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** El encabezado `Authorization`: grupo 1, la clave; grupo 2, su inquilino. */
export const BEARER = new RegExp(`^Bearer (cmk_(${UUID})_[A-Za-z0-9_-]{43})$`);

export function hashDeClave(clave: string): string {
  return createHash("sha256").update(clave).digest("hex");
}

export function claveNueva(tenantId: string): { clave: string; prefijo: string; hash: string } {
  // 32 bytes en base64url son los 43 caracteres de `BEARER`.
  const azar = randomBytes(32).toString("base64url");
  const clave = `cmk_${tenantId}_${azar}`;
  return { clave, prefijo: azar.slice(0, 8), hash: hashDeClave(clave) };
}
