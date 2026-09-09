/**
 * La puerta de una ruta: quién sos, qué podés, y cuánto venís pidiendo.
 *
 * Toda ruta de la API hacía lo mismo y en fila:
 *
 *   const ctx = await requireRole(...ALL_ROLES);          // sesión + fila de users
 *   const rl  = await rateLimit(buildUserKey(id, "…"));   // el cupo
 *   const datos = await loQueLaRutaHace();                // recién acá
 *
 * Son tres idas a Neon antes del primer byte útil, y la ida es lo que se paga:
 * las tres consultas se ejecutan en milisegundos, el viaje son ~65 ms cada uno.
 *
 * Las dos primeras NO dependen una de otra. Las dos necesitan el id del usuario
 * y nada más, y ese sale de la sesión. Con la sesión en la mano van juntas.
 *
 * `getSessionContext` está memoizada por pedido con el `cache` de React, así
 * que pedirla acá y que `requireRole` la vuelva a pedir adentro no cuesta un
 * viaje: cuesta cero.
 *
 * ── Lo que cambia de comportamiento, y por qué está bien ────────────────────
 *
 * El cupo ahora cuenta también los pedidos que rebotan por rol. Antes
 * `requireRole` tiraba primero y el limitador no se enteraba: alguien con
 * sesión válida y rol equivocado podía golpear una ruta prohibida sin tope
 * ninguno. Contarlos es lo que corresponde.
 *
 * Sin sesión sigue sin contarse. Ahí no hay a quién contarle: la clave del cupo
 * es el usuario.
 */

import "server-only";

import { getSessionContext } from "@/lib/auth/session";
import {
  requireRole,
  type RoleContext,
  type UserRole,
} from "@/lib/auth/require-role";
import { buildUserKey, rateLimit, type RateLimitResult } from "@/lib/rate-limit/index";
import { AppError } from "@/lib/errors";

export interface Entrada {
  ctx: RoleContext;
  rl: RateLimitResult;
}

/**
 * @param etiqueta  Qué se está pidiendo — el sufijo de la clave del cupo, uno
 *                  por ruta, para que dos pantallas distintas no compartan tope.
 *                  Una función cuando el cupo no es por usuario: el
 *                  re-análisis lo lleva por caso, y recibe el id para armarla.
 * @param cupo      Un perfil de `RATE_LIMIT_CONFIGS`.
 * @param roles     Los roles admitidos, como los tomaba `requireRole`.
 */
export async function entrar(
  etiqueta: string | ((userId: string) => string),
  cupo: { limit: number; windowMs: number },
  ...roles: UserRole[]
): Promise<Entrada> {
  const session = await getSessionContext();
  if (!session?.user) throw new AppError("MISSING_SESSION");
  const userId = session.user.id;

  const clave =
    typeof etiqueta === "function" ? etiqueta(userId) : buildUserKey(userId, etiqueta);

  const [ctx, rl] = await Promise.all([
    requireRole(...roles),
    rateLimit(clave, cupo),
  ]);

  return { ctx, rl };
}
