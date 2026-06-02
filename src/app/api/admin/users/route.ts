/**
 * GET  /api/admin/users  — list analysts in the current tenant (role=admin only)
 * POST /api/admin/users  — invite a new analyst via Supabase Admin API (role=admin only)
 *
 * AC17: Only admins can access this endpoint; others get 403 FORBIDDEN_ROLE.
 * RLS: The `users` table is tenant-scoped. Service-role is needed for POST to
 *       call supabase.auth.admin.createUser() — user-scoped client cannot create users.
 *
 * NOTE: POST requires SUPABASE_SERVICE_ROLE_KEY. If it is not set, the endpoint
 * returns 501 and logs a warning. This is documented in implementation-notes.md.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

// ── Auth guard helper ─────────────────────────────────────────────────────────

async function requireAdmin() {
  const supabase = await createServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (!user || authErr) {
    throw new AppError("MISSING_SESSION");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: userRow } = await (supabase as any)
    .from("users")
    .select("id, tenant_id, role")
    .eq("id", user.id)
    .single();

  if (!userRow) throw new AppError("MISSING_SESSION");
  if (userRow.role !== "admin") throw new AppError("FORBIDDEN_ROLE");

  return { supabase, user, userRow };
}

// ── GET /api/admin/users ──────────────────────────────────────────────────────

export async function GET() {
  try {
    const { supabase, userRow } = await requireAdmin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("users")
      .select("id, full_name, role, created_at")
      .eq("tenant_id", userRow.tenant_id)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[admin/users GET]", error.code);
      return err("INTERNAL_ERROR");
    }

    // Fetch emails from auth.users via service client (RLS-bypassed for admin access).
    // We join on id to get the email field which is only in auth.users.
    let authUsers: Array<{ id: string; email?: string }> = [];
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const serviceClient = createServiceClient();
      const { data: { users: authUsersData } = { users: [] } } =
        await serviceClient.auth.admin.listUsers({ perPage: 1000 });
      authUsers = authUsersData ?? [];
    }

    const emailById: Record<string, string> = {};
    for (const u of authUsers) {
      emailById[u.id] = u.email ?? "";
    }

    const rows = (data ?? []).map(
      (u: { id: string; full_name: string; role: string; created_at: string }) => ({
        id: u.id,
        full_name: u.full_name,
        email: emailById[u.id] ?? "",
        role: u.role,
        created_at: u.created_at,
      })
    );

    return ok({ users: rows });
  } catch (e) {
    return err(e);
  }
}

// ── POST /api/admin/users ─────────────────────────────────────────────────────

const CreateUserSchema = z.object({
  full_name: z.string().min(2).max(100),
  email: z.string().email(),
  role: z.enum(["analyst", "admin"]),
});

export async function POST(request: NextRequest) {
  try {
    const { userRow } = await requireAdmin();

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.warn("[admin/users POST] SUPABASE_SERVICE_ROLE_KEY not set — cannot create users");
      return err("INTERNAL_ERROR");
    }

    const body = await request.json();
    const parsed = CreateUserSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { full_name, email, role } = parsed.data;
    const serviceClient = createServiceClient();

    // Create auth user — Supabase sends a magic-link/invite email automatically.
    const { data: newAuthUser, error: createErr } =
      await serviceClient.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { full_name },
      });

    if (createErr || !newAuthUser.user) {
      console.error("[admin/users POST] auth.admin.createUser:", createErr?.message ?? "unknown");
      return err("INTERNAL_ERROR");
    }

    // Insert public.users row for the new analyst.
    const { error: insertErr } = await serviceClient
      .from("users" as never)
      .insert({
        id: newAuthUser.user.id,
        tenant_id: userRow.tenant_id,
        full_name,
        role,
      } as never);

    if (insertErr) {
      console.error("[admin/users POST] insert users row:", insertErr.code);
      // Best-effort: clean up auth user so we don't leave an orphan.
      await serviceClient.auth.admin.deleteUser(newAuthUser.user.id);
      return err("INTERNAL_ERROR");
    }

    return ok(
      {
        id: newAuthUser.user.id,
        email,
        full_name,
        role,
        message: "Usuario creado. Se enviará un correo de invitación.",
      },
      201
    );
  } catch (e) {
    return err(e);
  }
}
