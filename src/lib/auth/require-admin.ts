/**
 * requireAdmin — shared admin-role guard for Route Handlers.
 *
 * Usage:
 *   const { user, userRow } = await requireAdmin();
 *
 * Throws AppError('MISSING_SESSION')  if no valid session.
 * Throws AppError('FORBIDDEN_ROLE')   if role is not admin/owner.
 *
 * Spec: IC5 — Admin role check uses the same predicate as /api/admin/users.
 * Error code mapping: FORBIDDEN_ROLE → 403 per errors.ts.
 *
 * ── Por qué esto es una línea y antes eran cuarenta ─────────────────────────
 *
 * Era `requireRole(...ADMIN_ROLES)` escrito de nuevo: el mismo
 * `getSessionContext`, el mismo `firstRow` sobre `users` con las mismas tres
 * columnas, los mismos `AppError`, la misma forma de retorno. La única
 * diferencia real era que tipaba `role` como `string` en vez de `UserRole`.
 *
 * Eso hacía que la lista de roles con permiso de admin viviera en dos lugares,
 * y sólo uno se leía como la lista: `ADMIN_ROLES`. Agregar un rol ahí no
 * alcanzaba a las veintinueve rutas que entran por acá.
 */

import { requireRole, ADMIN_ROLES, type RoleContext } from "@/lib/auth/require-role";

/**
 * El contexto que devuelve la guarda.
 *
 * No trae un handle de base a propósito. Cuando lo traía era el del rol dueño,
 * y toda ruta que escribiera `const { db } = await requireRole()` quedaba
 * consultando por afuera de RLS sin que se notara: la consulta anda, devuelve
 * filas, y las filas son de todos los inquilinos. Para leer o escribir,
 * `enTenant({ tenantId: userRow.tenant_id }, …)`.
 */
export type AdminContext = RoleContext;

/**
 * Validate that the current request has an admin session.
 *
 * @throws AppError('MISSING_SESSION') — no authenticated user
 * @throws AppError('FORBIDDEN_ROLE')  — authenticated but not admin/owner
 */
export async function requireAdmin(): Promise<AdminContext> {
  return requireRole(...ADMIN_ROLES);
}
