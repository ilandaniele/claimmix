import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { authUsers, users } from "@/lib/db/schema";
import { enTenant } from "@/data/scope";

interface NewAuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean;
}

/**
 * Emails that are provisioned as admins on first sign-in (comma-separated in
 * ADMIN_EMAILS). Case-insensitive. Applies to both the app profile role
 * (users.role — what requireAdmin checks) and the Better Auth role
 * ("user".role — what the better-auth admin plugin checks).
 *
 * SECURITY: requires a VERIFIED email. email/password signup runs with
 * requireEmailVerification=false, so `user.email` on that path is attacker-
 * controlled and unproven. Without the emailVerified gate, anyone could
 * pre-register an allowlisted address that has no account yet and be granted
 * admin. Google sign-in sets emailVerified=true (Google proves ownership), so
 * the intended admins still auto-promote.
 */
function isAllowlistedAdmin(email: string | null | undefined, emailVerified: boolean | undefined): boolean {
  if (!emailVerified) return false;
  const raw = process.env.ADMIN_EMAILS;
  if (!raw || !email) return false;
  const allowed = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

/**
 * Whether this email may be provisioned into the default tenant at all.
 *
 * SECURITY — this is the tenant's front door. /registro is a public route and
 * Google sign-in is open, and both funnel through provisionUserProfile, which
 * used to drop *any* new account into GOOGLE_DEFAULT_TENANT_ID as an "analyst".
 * /bandeja only checks for a session (no role gate) and GET /api/cases accepts
 * ALL_ROLES, so a stranger who registered could read every claim in the
 * production tenant — names, DNI, policy numbers, addresses.
 *
 * Allowed entries in SIGNUP_ALLOWED_EMAILS (comma-separated), plus everything
 * in ADMIN_EMAILS:
 *   - a full address        analista@aseguradora.com
 *   - a whole domain        @aseguradora.com   (onboarding an insurer's staff)
 *
 * Deliberately CLOSED when neither variable is set: an unconfigured deploy must
 * not hand out access to real claims. Existing users are unaffected — this hook
 * only runs on user creation and returns early when a profile already exists.
 * To add someone, list them here or have an admin create the user from
 * /admin/users (which provisions into the admin's own tenant).
 */
function isSignupAllowed(
  email: string | null | undefined,
  emailVerified: boolean | undefined
): boolean {
  if (!email) return false;

  // The address has to be proven, not merely typed.
  //
  // requireEmailVerification is false on the password path, so `user.email` is
  // whatever the person entered. Without this check, anyone who guessed an
  // address on the allowlist that had not registered yet could sign up as it
  // and be provisioned into the production tenant as an analyst — which the
  // note above spells out means reading every claim in it: names, DNI, policy
  // numbers, addresses.
  //
  // Not hypothetical: adding a new company mailbox to ADMIN_EMAILS opened
  // exactly that window on an address anyone could guess from the company
  // name, and it stayed open until someone thought to check.
  //
  // Google sign-in sets emailVerified, so the intended path is untouched. A
  // password signup now lands without a profile row, which is the same
  // fail-safe the function already used for a stranger: the account exists,
  // it reaches nothing, and an admin attaches it from /admin/users.
  if (!emailVerified) return false;
  const entries = [process.env.SIGNUP_ALLOWED_EMAILS, process.env.ADMIN_EMAILS]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return false;

  const addr = email.trim().toLowerCase();
  const domain = addr.slice(addr.indexOf("@"));
  return entries.some((e) => (e.startsWith("@") ? e === domain : e === addr));
}

export function resolveDefaultTenantId(): string | null {
  return (
    process.env.GOOGLE_DEFAULT_TENANT_ID ??
    process.env.DEFAULT_TENANT_ID ??
    process.env.GMAIL_TENANT_ID ??
    null
  );
}

/**
 * Creates the public.users profile row for a freshly created Better Auth user.
 * Runs as a databaseHooks user.create.after hook, so it covers both
 * email/password signup and first-time Google sign-in. The admin create-user
 * flow updates tenant/role afterwards; the existence guard keeps this hook
 * idempotent.
 *
 * Membership in the tenant is the profile row: an account without one resolves
 * no tenant, so every page redirects to /login and every API returns 401. That
 * makes withholding it the fail-safe way to refuse an unapproved signup — no
 * half-granted access, and an admin can still attach the person later.
 */
export async function provisionUserProfile(user: NewAuthUser): Promise<void> {
  // sin-inquilino: Pregunta si el perfil ya existe, antes de que haya inquilino alguno.
  // Es el alta: el contexto todavía no existe.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (existing.length > 0) return;

  if (!isSignupAllowed(user.email, user.emailVerified)) {
    // No profile row → no tenant → no access to any claim. The Better Auth
    // account survives so an admin can approve the person from /admin/users.
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "claimmix",
        msg: "auth.signup.not_allowlisted",
        // LLM06 / PII: log the domain only, never the full address.
        email_domain: user.email?.slice(user.email.indexOf("@")) ?? null,
      }),
    );
    return;
  }

  const tenantId = resolveDefaultTenantId();
  if (!tenantId) {
    throw new Error(
      "GOOGLE_DEFAULT_TENANT_ID (or DEFAULT_TENANT_ID / GMAIL_TENANT_ID) is required to provision new users",
    );
  }

  const isAdmin = isAllowlistedAdmin(user.email, user.emailVerified);

  await enTenant({ tenantId }, (db) =>
    db.insert(users).values({
      id: user.id,
      tenant_id: tenantId,
      full_name: user.name || user.email || "Analyst",
      role: isAdmin ? "admin" : "analyst",
    })
  );

  if (isAdmin) {
    // Keep the Better Auth role in sync so the admin plugin agrees with
    // requireAdmin. Best-effort: profile row above is the source of truth.
    try {
      // sin-inquilino: `auth_users` es la tabla de Better Auth, sin columna de inquilino.
      await db.update(authUsers).set({ role: "admin" }).where(eq(authUsers.id, user.id));
    } catch {
      // non-fatal — admin plugin role can be aligned manually
    }
  }
}
