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
 */

import { eq } from "drizzle-orm";

import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { users } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";

export interface AdminContext {
  user: { id: string; email?: string };
  userRow: { id: string; tenant_id: string; role: string };
}

/**
 * Validate that the current request has an admin session.
 * No devuelve un handle de base a propósito. Cuando devolvía uno, era el del
 * rol dueño, y toda ruta que escribiera `const { db } = await requireRole()`
 * quedaba consultando por afuera de RLS sin que se notara: la consulta anda,
 * devuelve filas, y las filas son de todos los inquilinos. Para leer o
 * escribir, `enTenant({ tenantId: userRow.tenant_id }, …)`.
 *
 * @throws AppError('MISSING_SESSION') — no authenticated user
 * @throws AppError('FORBIDDEN_ROLE')  — authenticated but not admin/owner
 */
export async function requireAdmin(): Promise<AdminContext> {
  const session = await getSessionContext();
  if (!session?.user) {
    throw new AppError("MISSING_SESSION");
  }

  const userRow = firstRow(
    // sin-inquilino: El arranque de toda petición: de acá sale el inquilino que después
    // usa `enTenant`. Por definición no puede ir adentro.
    await db
      .select({ id: users.id, tenant_id: users.tenant_id, role: users.role })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1),
  );

  if (!userRow) throw new AppError("MISSING_SESSION");
  // 'owner' is a superset of 'admin' (agent learning workflow roles).
  if (userRow.role !== "admin" && userRow.role !== "owner") {
    throw new AppError("FORBIDDEN_ROLE");
  }

  return {
    user: { id: session.user.id, email: session.user.email ?? undefined },
    userRow,
  };
}
