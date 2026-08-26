/**
 * requireRole — shared role guard for Route Handlers.
 *
 * Role model (users.role):
 *   owner      — tenant owner; everything an admin can do
 *   admin      — manage users, configuration, prompts, training
 *   specialist — review claims, confirm fields, confirm training examples
 *   analyst    — legacy operational role; review claims, confirm fields
 *   viewer     — read-only: inspect claims and extracted JSON
 *
 * Usage:
 *   const ctx = await requireRole("owner", "admin", "specialist");
 *
 * Throws AppError('MISSING_SESSION') if no valid session.
 * Throws AppError('FORBIDDEN_ROLE')  if the user's role is not in the list.
 *
 * NOTE: with RLS gone, ctx.userRow.tenant_id is the ONLY tenant boundary.
 * Every query on tenant-owned tables MUST filter by it explicitly.
 */

import { eq } from "drizzle-orm";

import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { users } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";

export const ALL_ROLES = ["owner", "admin", "specialist", "analyst", "viewer"] as const;
export type UserRole = (typeof ALL_ROLES)[number];

/** Roles allowed to confirm training examples (spec item 3). */
export const TRAINING_APPROVER_ROLES: UserRole[] = ["owner", "admin", "specialist"];

/** Roles with admin-level configuration access. */
export const ADMIN_ROLES: UserRole[] = ["owner", "admin"];

/** Roles allowed to mutate cases / confirm fields (everything except viewer). */
export const CASE_EDITOR_ROLES: UserRole[] = ["owner", "admin", "specialist", "analyst"];

export interface RoleContext {
  user: { id: string; email?: string };
  userRow: { id: string; tenant_id: string; role: UserRole };
}

/**
 * Validate the session and require one of the given roles.
 * No devuelve un handle de base a propósito. Cuando devolvía uno, era el del
 * rol dueño, y toda ruta que escribiera `const { db } = await requireRole()`
 * quedaba consultando por afuera de RLS sin que se notara: la consulta anda,
 * devuelve filas, y las filas son de todos los inquilinos. Para leer o
 * escribir, `enTenant({ tenantId: userRow.tenant_id }, …)`.
 */
export async function requireRole(...roles: UserRole[]): Promise<RoleContext> {
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
  if (!roles.includes(userRow.role as UserRole)) {
    throw new AppError("FORBIDDEN_ROLE");
  }

  return {
    user: { id: session.user.id, email: session.user.email ?? undefined },
    userRow: userRow as RoleContext["userRow"],
  };
}
