/**
 * Server Action for account creation — /registro page.
 *
 * Creates a Better Auth user (email+password) via auth.api.signUpEmail. The
 * databaseHooks user.create.after hook (provisionUserProfile) creates the
 * public.users profile row in the default tenant with the "analyst" role —
 * same provisioning rule as first-time Google sign-in. Admins can promote
 * accounts later from /admin/users.
 *
 * signUpEmail auto-signs the user in (nextCookies sets the session cookie),
 * so no separate sign-in call is needed.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { auth } from "@/lib/auth";
import { resolveDefaultTenantId } from "@/lib/auth/provision";
import {
  RATE_LIMIT_CONFIGS,
  clientIpFromHeaders,
  rateLimit,
} from "@/lib/rate-limit/index";
import { SignUpSchema } from "@/lib/schemas/auth";

type SignUpState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

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
  // La misma resolución que la ruta HTTP: prefiere `x-vercel-forwarded-for`,
  // que es la única cabecera que no puede escribir quien llama.
  const ip = clientIpFromHeaders(headerStore);
  const ua = headerStore.get("user-agent") ?? null;

  const rl = await rateLimit(`signup:${ip}`, RATE_LIMIT_CONFIGS.AUTH_SIGN_UP);
  if (!rl.allowed) {
    return {
      error: `Demasiados intentos. Intente en ${rl.retryAfterSeconds} segundos.`,
    };
  }

  // ── 3. Preconditions ───────────────────────────────────────────────────────
  // The provisioning hook needs a default tenant; without it user creation
  // would fail halfway. Fail fast with the same message as before.
  const tenantId = resolveDefaultTenantId();
  if (!tenantId) {
    return { error: "El registro no está habilitado. Contactá al administrador." };
  }

  // ── 4. Create the auth user (profile row provisioned by the create hook) ──
  let userId: string;
  let signedIn: boolean;
  try {
    const result = await auth.api.signUpEmail({
      body: { name: full_name, email, password },
      headers: headerStore,
    });
    userId = result.user.id;
    // token is null when auto sign-in did not happen.
    signedIn = result.token !== null;
  } catch (e) {
    if (e instanceof APIError) {
      const code = e.body?.code;
      if (code === "USER_ALREADY_EXISTS" || /already/i.test(e.body?.message ?? "")) {
        return { error: "Ya existe una cuenta con ese correo. Iniciá sesión." };
      }
      console.error("[registro] auth.api.signUpEmail:", code ?? e.message);
    } else {
      console.error(
        "[registro] auth.api.signUpEmail:",
        e instanceof Error ? e.name : "unknown"
      );
    }
    return { error: "No se pudo crear la cuenta. Intentá de nuevo." };
  }

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.AUTH_SIGN_UP,
    target_type: "user",
    target_id: userId,
    payload: { role: "analyst", self_registered: true },
    ip,
    ua,
  });

  // ── 5. Redirect (session cookie already set by signUpEmail) ───────────────
  if (!signedIn) {
    // Account exists but auto-login did not happen — send them to the login form.
    redirect("/login");
  }

  redirect("/bandeja");
}
