/**
 * Admin — gestión de analistas (W7 / AC17).
 *
 * Server Component: fetches the user list and current analyst role.
 * Non-admin roles are redirected to /bandeja with a redirect (no toast possible
 * from a server component — the redirect itself is the enforcement).
 *
 * Features:
 *   - Table: Nombre | Email | Rol | Estado | Creado
 *   - Role badge: Analista (blue), Supervisor (purple — mapped from admin), Admin (red)
 *   - Create user: delegated to AdminUsersClient for the dialog interaction
 *   - Role guard: non-admin → redirect to /bandeja
 */

import { createServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { AdminUsersClient } from "./AdminUsersClient";

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  created_at: string;
}

async function fetchUsers(): Promise<{
  users: UserRow[];
  currentRole: string;
} | null> {
  const supabase = await createServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (!user || authErr) return null;

  // Get current analyst's role
   
  const { data: currentUser } = await (supabase as any)
    .from("users")
    .select("role, tenant_id")
    .eq("id", user.id)
    .single();

  if (!currentUser) return null;

  // Only admins can view this page
  if (currentUser.role !== "admin") {
    redirect("/bandeja");
  }

  // Fetch all analysts in the tenant
   
  const { data: usersData } = await (supabase as any)
    .from("users")
    .select("id, full_name, role, created_at")
    .eq("tenant_id", currentUser.tenant_id)
    .order("created_at", { ascending: true });

  // Note: emails live in auth.users which requires service-role.
  // The API route GET /api/admin/users returns full data including emails.
  // Here we render the initial list without emails (displayed as "—")
  // because the service-role client cannot be used in Server Components directly.
  // The AdminUsersClient fetches the full list via the API route on mount.
  const users: UserRow[] = (usersData ?? []).map(
    (u: { id: string; full_name: string; role: string; created_at: string }) => ({
      id: u.id,
      full_name: u.full_name,
      email: "", // filled by client-side API call
      role: u.role,
      created_at: u.created_at,
    })
  );

  return { users, currentRole: currentUser.role };
}

export default async function AdminUsersPage() {
  const result = await fetchUsers();

  if (!result) {
    redirect("/login");
  }

  return (
    <div className="px-6 py-8 max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Gestión de analistas
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Usuarios registrados en el sistema
          </p>
        </div>
      </div>

      <AdminUsersClient initialUsers={result.users} />
    </div>
  );
}
