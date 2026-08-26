/**
 * Server Actions for authentication — login page.
 *
 * signIn: validates email+password, calls auth.api.signInEmail (Better Auth)
 * with the request headers so nextCookies sets the session cookie, then
 * redirects to /bandeja.
 *
 * signOut: revokes the Better Auth session, then redirects to /login.
 *
 * signInWithGoogle: asks Better Auth for the Google OAuth URL
 * (auth.api.signInSocial) and redirects the browser there. The provider
 * redirects back to /api/auth/callback/google (handled by the [...all] route).
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { auth } from "@/lib/auth";
import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildSignInKey,
} from "@/lib/rate-limit/index";
import { SignInSchema } from "@/lib/schemas/auth";

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

  // ── 3. Better Auth sign-in (nextCookies sets the session cookie) ──────────
  let userId: string;
  try {
    const result = await auth.api.signInEmail({
      body: { email, password },
      headers: headerStore,
    });
    userId = result.user.id;
  } catch {
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
  // sin-inquilino: Ésta es la consulta que AVERIGUA de qué inquilino es el que entra.
  // Es el arranque de la sesión: todavía no hay inquilino que fijar.
  const [userRow] = await db
    .select({ tenant_id: users.tenant_id, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const tenantId = userRow?.tenant_id ?? "00000000-0000-0000-0000-000000000000";

  // ── 5. Write success audit log ─────────────────────────────────────────────
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.AUTH_SUCCESS,
    target_type: "user",
    target_id: userId,
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
  const session = await getSessionContext();

  if (session?.user) {
    // sin-inquilino: Idem.
    const [userRow] = await db
      .select({ tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    await writeAuditLog({
      tenant_id: userRow?.tenant_id ?? "00000000-0000-0000-0000-000000000000",
      actor_id: session.user.id,
      event_type: AuditEvent.AUTH_SIGN_OUT,
      target_type: "user",
      target_id: session.user.id,
      payload: {},
    });

    await auth.api.signOut({ headers: await headers() });
  }

  redirect("/login");
}

export async function signInWithGoogle(): Promise<void> {
  let url: string | undefined;
  try {
    const result = await auth.api.signInSocial({
      body: {
        provider: "google",
        callbackURL: "/bandeja",
        errorCallbackURL: "/login?error=auth_callback_failed",
      },
      headers: await headers(),
    });
    url = result.url ?? undefined;
  } catch {
    url = undefined;
  }

  if (!url) {
    redirect("/login?error=google_signin_failed");
  }

  redirect(url);
}
