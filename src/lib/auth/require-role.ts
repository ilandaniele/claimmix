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
 */

import { createServerClient } from "@/lib/supabase/server";
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
  supabase: Awaited<ReturnType<typeof createServerClient>>;
  user: { id: string; email?: string };
  userRow: { id: string; tenant_id: string; role: UserRole };
}

/**
 * Validate the session and require one of the given roles.
 * Returns the Supabase client, auth user, and public.users row.
 */
export async function requireRole(...roles: UserRole[]): Promise<RoleContext> {
  const supabase = await createServerClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (!user || authErr) {
    throw new AppError("MISSING_SESSION");
  }

  const { data: userRow } = await (supabase as any)
    .from("users")
    .select("id, tenant_id, role")
    .eq("id", user.id)
    .single();

  if (!userRow) throw new AppError("MISSING_SESSION");
  if (!roles.includes(userRow.role as UserRole)) {
    throw new AppError("FORBIDDEN_ROLE");
  }

  return { supabase, user, userRow: userRow as RoleContext["userRow"] };
}
