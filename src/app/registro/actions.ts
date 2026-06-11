/**
 * Server Action for account creation — /registro page.
 *
 * Creates a Supabase auth user (email+password) plus the public.users profile
 * row in the default tenant, mirroring the Google sign-in auto-provisioning
 * (provisionGoogleUserIfAllowed): new self-registered accounts get the
 * "analyst" role. Admins can promote them later from /admin/users.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { SignUpSchema } from "@/lib/schemas/auth";
import { rateLimit, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

type SignUpState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

/** Default tenant for self-registered users — same resolution as Google sign-in. */
function resolveDefaultTenantId(): string | null {
  return (
    process.env.GOOGLE_DEFAULT_TENANT_ID ??
    process.env.DEFAULT_TENANT_ID ??
    process.env.GMAIL_TENANT_ID ??
    null
  );
}

export async function signUp(
  _prev: SignUpState,
  formData: FormData
): Promise<SignUpState> {
  // ── 1. Validate input ──────────────────────────────────────────────────────
  const parsed = SignUpSchema.safeParse({
    full_name: formData.get("full_name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { full_name, email, password } = parsed.data;

  // ── 2. Rate limiting (per IP) ──────────────────────────────────────────────
  const headerStore = await headers();
  const xff = headerStore.get("x-forwarded-for");
  const ip = xff ? xff.split(",")[0].trim() : "anonymous";
  const ua = headerStore.get("user-agent") ?? null;

  const rl = await rateLimit(`signup:${ip}`, RATE_LIMIT_CONFIGS.AUTH_SIGN_UP);
  if (!rl.allowed) {
    return {
      error: `Demasiados intentos. Intente en ${rl.retryAfterSeconds} segundos.`,
    };
  }

  // ── 3. Preconditions ───────────────────────────────────────────────────────
  const tenantId = resolveDefaultTenantId();
  if (!tenantId || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: "El registro no está habilitado. Contactá al administrador." };
  }

  // ── 4. Create the auth user + profile row ─────────────────────────────────
  const serviceClient = createServiceClient();
  const { data: created, error: createErr } =
    await serviceClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });

  if (createErr || !created.user) {
    // Supabase reports duplicates with the email_exists code (422).
    const code = (createErr as { code?: string } | null)?.code;
    if (code === "email_exists" || /already/i.test(createErr?.message ?? "")) {
      return { error: "Ya existe una cuenta con ese correo. Iniciá sesión." };
    }
    console.error("[registro] auth.admin.createUser:", code ?? createErr?.message);
    return { error: "No se pudo crear la cuenta. Intentá de nuevo." };
  }

  const { error: insertErr } = await serviceClient
    .from("users" as never)
    .insert({
      id: created.user.id,
      tenant_id: tenantId,
      full_name,
      role: "analyst",
    } as never);

  if (insertErr) {
    console.error("[registro] insert users row:", insertErr.code);
    // Best-effort: clean up the auth user so we don't leave an orphan.
    await serviceClient.auth.admin.deleteUser(created.user.id);
    return { error: "No se pudo crear la cuenta. Intentá de nuevo." };
  }

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: created.user.id,
    event_type: AuditEvent.AUTH_SIGN_UP,
    target_type: "user",
    target_id: created.user.id,
    payload: { role: "analyst", self_registered: true },
    ip,
    ua,
  });

  // ── 5. Sign the new user in and redirect ──────────────────────────────────
  const supabase = await createServerClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    // Account exists but auto-login failed — send them to the login form.
    redirect("/login");
  }

  redirect("/bandeja");
}
