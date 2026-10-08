/**
 * La puerta de /api/v1: el sistema de la aseguradora entra con su clave, no
 * con una sesión (B5).
 *
 * La clave es `cmk_<tenantId>_<43 base64url>` y trae el inquilino adentro: así
 * se lee el hash con RLS, en el contexto de ese inquilino, sin buscar la clave
 * en todas las filas. Si la clave miente sobre el inquilino, el hash de ese
 * otro inquilino no coincide y da el mismo 401.
 */

import "server-only";

import { esBaseInexistente } from "@/data/bases";
import { enTenant, type TenantContext } from "@/data/scope";
import { err } from "@/lib/api/respond";
import { coreSyncSettings } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { getClientIp, rateLimit, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { timingSafeStringEqual } from "@/lib/security/compare";
import { BEARER, hashDeClave, SIN_CACHE } from "@/server/core-sync/clave";
import { esFaltaDe0036 } from "@/server/core-sync/config";

export { SIN_CACHE };

function rechazar(): Response {
  return err(new AppError("INVALID_CREDENTIALS"), undefined, {
    ...SIN_CACHE,
    "WWW-Authenticate": "Bearer",
  });
}

/** El inquilino de la clave, o la respuesta que hay que devolver tal cual. */
export async function autenticarClave(request: Request): Promise<TenantContext | Response> {
  // Una clave malformada no llega a la base, ni siquiera al cupo.
  const partes = BEARER.exec(request.headers.get("authorization") ?? "");
  if (!partes) return rechazar();
  const [, clave, tenantId] = partes;

  const rl = await rateLimit(claveDeCupo("core-api", getClientIp(request)), RATE_LIMIT_CONFIGS.CORE_API);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED"), undefined, {
      ...SIN_CACHE,
      "Retry-After": String(rl.retryAfterSeconds),
    });
  }

  const ctx: TenantContext = { tenantId };
  let guardado: string | null = null;
  try {
    const [fila] = await enTenant(ctx, (db) =>
      db.select({ hash: coreSyncSettings.api_key_hash }).from(coreSyncSettings)
    );
    guardado = fila?.hash ?? null;
  } catch (e) {
    // La clave nombra un inquilino sin base (nunca la tuvo o se dio de baja): igual que una clave mala.
    if (esBaseInexistente(e)) return rechazar();
    if (!esFaltaDe0036(e)) throw e;
  }

  // Se compara siempre, haya fila o no: sin fila, contra un hash que ninguna
  // clave da. Así el tiempo no dice si el inquilino tiene clave.
  if (!timingSafeStringEqual(hashDeClave(clave), guardado ?? "0".repeat(64))) return rechazar();
  return ctx;
}
