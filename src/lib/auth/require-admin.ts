/**
 * requireAdmin — shared admin-role guard for Route Handlers.
 *
 * Usage:
 *   const { user, userRow } = await requireAdmin();
 *
 * Throws AppError('MISSING_SESSION')  if no valid session.
 * Throws AppError('FORBIDDEN_ROLE')   if user.role !== 'admin'.
 *
 * Spec: IC5 — Admin role check uses the same predicate as /api/admin/users.
 * Error code mapping: FORBIDDEN_ROLE → 403 per errors.ts.
 */

import { createServerClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";

export interface AdminContext {
  supabase: Awaited<ReturnType<typeof createServerClient>>;
  user: { id: string; email?: string };
  userRow: { id: string; tenant_id: string; role: string };
}

/**
 * Validate that the current request has an admin session.
 * Returns the Supabase client, the auth user, and the public.users row.
 *
 * @throws AppError('MISSING_SESSION') — no authenticated user
 * @throws AppError('FORBIDDEN_ROLE')  — authenticated but role !== 'admin'
 */
export async function requireAdmin(): Promise<AdminContext> {
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
  // 'owner' is a superset of 'admin' (agent learning workflow roles).
  if (userRow.role !== "admin" && userRow.role !== "owner") {
    throw new AppError("FORBIDDEN_ROLE");
  }

  return { supabase, user, userRow };
}
