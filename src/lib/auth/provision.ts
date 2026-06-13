import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

interface NewAuthUser {
  id: string;
  name: string;
  email: string;
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

  await db.insert(users).values({
    id: user.id,
    tenant_id: tenantId,
    full_name: user.name || user.email || "Analyst",
    role: "analyst",
  });
}
