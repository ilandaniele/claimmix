/**
 * POST /api/auth/sign-out
 *
 * Signs out the current analyst by invalidating the Supabase session.
 * Clears the session cookie (handled by @supabase/ssr automatically).
 *
 * Returns 204 No Content on success.
 * Returns 401 if there is no active session.
 */

import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

type UserRow = Database["public"]["Tables"]["users"]["Row"];
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { getClientIp } from "@/lib/rate-limit/index";

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const ip = getClientIp(request);
  const ua = request.headers.get("user-agent") ?? null;

  // Verify active session before sign-out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "MISSING_SESSION", message: "Se requiere autenticación." } },
      { status: 401 }
    );
  }

  // Fetch tenant_id for the audit log.
  const { data: userRowRaw } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();
  const userRow = userRowRaw as UserRow | null;

  const tenantId = userRow?.tenant_id ?? "00000000-0000-0000-0000-000000000000";

  // Sign out — Supabase SSR clears the cookie automatically.
  await supabase.auth.signOut();

  // Write audit log.
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: user.id,
    event_type: AuditEvent.AUTH_SIGN_OUT,
    target_type: "user",
    target_id: user.id,
    payload: {},
    ip,
    ua,
  });

  return new NextResponse(null, { status: 204 });
}
