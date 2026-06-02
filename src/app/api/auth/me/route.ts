/**
 * GET /api/auth/me
 *
 * Returns the current analyst's profile.
 *
 * Requires authentication. Returns:
 *   { id, email, full_name, role, tenant_id }
 *
 * Returns 401 if there is no active session.
 */

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

type UserRow = Database["public"]["Tables"]["users"]["Row"];

export async function GET() {
  const supabase = await createServerClient();

  // getUser() validates JWT with Supabase Auth API — never use getSession().
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: { code: "MISSING_SESSION", message: "Se requiere autenticación." } },
      { status: 401 }
    );
  }

  // Fetch the analyst's public.users profile (tenant_id, role, full_name).
  const { data: userRowRaw, error: dbError } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  if (dbError || !userRowRaw) {
    // User exists in auth.users but not in public.users — account not fully set up.
    console.error("[me] User profile not found for auth user:", user.id);
    return NextResponse.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "El perfil del analista no fue encontrado.",
        },
      },
      { status: 404 }
    );
  }

  const userRow = userRowRaw as UserRow;

  return NextResponse.json({
    id: userRow.id,
    email: user.email,
    full_name: userRow.full_name,
    role: userRow.role,
    tenant_id: userRow.tenant_id,
  });
}
