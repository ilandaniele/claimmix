/**
 * GET   /api/auth/me — current analyst's profile.
 *         { id, email, full_name, role, tenant_id, locale }
 * PATCH /api/auth/me — update own preferences. Body: { locale: "es-AR" | "en-US" }.
 *         Persists the UI language per account (applied on any device at login).
 *         RLS: users_update_own (id = auth.uid()).
 *
 * Returns 401 if there is no active session.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

type UserRow = Database["public"]["Tables"]["users"]["Row"];

const PatchMeSchema = z.object({
  locale: z.enum(["es-AR", "en-US"]),
});

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
    locale: userRow.locale ?? null,
  });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createServerClient();

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

  const body = await request.json().catch(() => null);
  const parsed = PatchMeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Parámetros inválidos.",
          details: parsed.error.flatten(),
        },
      },
      { status: 400 }
    );
  }

  const { error: updateError } = await (supabase as any)
    .from("users")
    .update({ locale: parsed.data.locale })
    .eq("id", user.id);

  if (updateError) {
    // 42703 = column missing (migration 0016 not applied) — preference simply
    // won't persist across devices yet; the cookie still works. Not a 500.
    if (updateError.code === "42703") {
      return NextResponse.json({ ok: true, persisted: false });
    }
    console.error("[me PATCH]", updateError.code);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "No se pudo guardar la preferencia." } },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, persisted: true });
}
