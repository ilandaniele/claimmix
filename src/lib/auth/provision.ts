import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { authUsers, users } from "@/lib/db/schema";

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
 */
export async function provisionUserProfile(user: NewAuthUser): Promise<void> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (existing.length > 0) return;

  const tenantId = resolveDefaultTenantId();
  if (!tenantId) {
    throw new Error(
      "GOOGLE_DEFAULT_TENANT_ID (or DEFAULT_TENANT_ID / GMAIL_TENANT_ID) is required to provision new users",
    );
  }

  const isAdmin = isAllowlistedAdmin(user.email, user.emailVerified);

  await db.insert(users).values({
    id: user.id,
    tenant_id: tenantId,
    full_name: user.name || user.email || "Analyst",
    role: isAdmin ? "admin" : "analyst",
  });

  if (isAdmin) {
    // Keep the Better Auth role in sync so the admin plugin agrees with
    // requireAdmin. Best-effort: profile row above is the source of truth.
    try {
      await db.update(authUsers).set({ role: "admin" }).where(eq(authUsers.id, user.id));
    } catch {
      // non-fatal — admin plugin role can be aligned manually
    }
  }
}
