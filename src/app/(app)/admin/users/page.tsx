/**
 * Admin — gestión de analistas.
 *
 * Server Component: fetches the user list and current analyst role.
 * Non-admin roles are redirected to /bandeja.
 */

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/require-admin";
import { db } from "@/lib/db";
import { authUsers, users } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { AdminUsersClient } from "./AdminUsersClient";

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  created_at: string;
}

type UserRole = "owner" | "admin" | "specialist" | "analyst" | "viewer";

export default async function AdminUsersPage() {
  let ctx: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") redirect("/login");
    redirect("/bandeja");
  }

  const { userRow } = ctx;

  // Fetch all users in this tenant joined with auth_users for email
  const rows = await db
    .select({
      id: users.id,
      full_name: users.full_name,
      role: users.role,
      created_at: users.created_at,
      email: authUsers.email,
    })
    .from(users)
    .leftJoin(authUsers, eq(users.id, authUsers.id))
    .where(eq(users.tenant_id, userRow.tenant_id))
    .orderBy(users.created_at);

  const initialUsers: UserRow[] = rows.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    email: r.email ?? "",
    role: r.role as UserRole,
    created_at: r.created_at,
  }));

  return (
    <div className="px-6 py-8 max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Gestión de usuarios
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Invitá usuarios y asigná roles operativos o administradores.
          </p>
        </div>
      </div>

      <AdminUsersClient
        initialUsers={initialUsers}
        currentUserId={ctx.user.id}
        currentUserRole={userRow.role}
      />
    </div>
  );
}
