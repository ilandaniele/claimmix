/**
 * Server Actions for authentication — login page.
 *
 * signIn: validates email+password, calls POST /api/auth/sign-in internally
 * via direct Supabase call (not HTTP self-call), then redirects to /bandeja.
 *
 * signOut: calls POST /api/auth/sign-out, then redirects to /login.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { SignInSchema } from "@/lib/schemas/auth";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildSignInKey,
} from "@/lib/rate-limit/index";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { headers } from "next/headers";
import type { Database } from "@/lib/supabase/types";

type UserRow = Database["public"]["Tables"]["users"]["Row"];

type SignInState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

/**
 * Sign in the analyst.
 * Returns error state on failure; calls redirect() on success.
 */
export async function signIn(
  _prev: SignInState,
  formData: FormData
): Promise<SignInState> {
  // ── 1. Validate input ──────────────────────────────────────────────────────
  const parsed = SignInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { email, password } = parsed.data;

  // ── 2. Rate limiting ───────────────────────────────────────────────────────
  const headerStore = await headers();
  const xff = headerStore.get("x-forwarded-for");
  const ip = xff ? xff.split(",")[0].trim() : "anonymous";
  const ua = headerStore.get("user-agent") ?? null;

  const rateLimitKey = buildSignInKey(ip, email);
  const rl = await rateLimit(rateLimitKey, RATE_LIMIT_CONFIGS.AUTH_SIGN_IN);

  if (!rl.allowed) {
    await writeAuditLog({
      tenant_id: "00000000-0000-0000-0000-000000000000",
      actor_id: null,
      event_type: AuditEvent.AUTH_RATE_LIMITED,
      target_type: "auth",
      target_id: null,
      payload: {
        ip_prefix: ip.split(".").slice(0, 3).join("."),
      },
      ip,
      ua,
    });

    return {
      error: `Demasiados intentos. Intente en ${rl.retryAfterSeconds} segundos.`,
    };
  }

  // ── 3. Supabase sign-in ────────────────────────────────────────────────────
  const supabase = await createServerClient();
  const { data, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !data.session || !data.user) {
    await writeAuditLog({
      tenant_id: "00000000-0000-0000-0000-000000000000",
      actor_id: null,
      event_type: AuditEvent.AUTH_FAILURE,
      target_type: "auth",
      target_id: null,
      payload: { ip_prefix: ip.split(".").slice(0, 3).join(".") },
      ip,
      ua,
    });

    return { error: "Credenciales inválidas." };
  }

  // ── 4. Fetch public.users row for tenant_id + role ─────────────────────────
  const { data: userRowRaw } = await supabase
    .from("users")
    .select("*")
    .eq("id", data.user.id)
    .single();
  const userRow = userRowRaw as UserRow | null;

  const tenantId = userRow?.tenant_id ?? "00000000-0000-0000-0000-000000000000";

  // ── 5. Write success audit log ─────────────────────────────────────────────
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: data.user.id,
    event_type: AuditEvent.AUTH_SUCCESS,
    target_type: "user",
    target_id: data.user.id,
    payload: { role: userRow?.role ?? "unknown" },
    ip,
    ua,
  });

  // ── 6. Redirect to bandeja — do NOT wrap in try/catch ─────────────────────
  redirect("/bandeja");
}

/**
 * Sign out the analyst and redirect to login.
 * Can be called from any server action or form action.
 */
export async function signOut(): Promise<void> {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: userRowRaw } = await supabase
      .from("users")
      .select("*")
      .eq("id", user.id)
      .single();
    const userRow = userRowRaw as UserRow | null;

    await writeAuditLog({
      tenant_id: userRow?.tenant_id ?? "00000000-0000-0000-0000-000000000000",
      actor_id: user.id,
      event_type: AuditEvent.AUTH_SIGN_OUT,
      target_type: "user",
      target_id: user.id,
      payload: {},
    });

    await supabase.auth.signOut();
  }

  redirect("/login");
}
