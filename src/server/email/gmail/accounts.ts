import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailAccounts } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";

const TOKEN_ALGORITHM = "aes-256-gcm";

export interface GmailAccount {
  id: string;
  tenantId: string;
  email: string;
  refreshToken: string;
  enabled: boolean;
}

export interface GmailAccountListRow {
  id: string;
  email: string;
  enabled: boolean;
  last_connected_at: string | null;
  last_error: string | null;
  watch_expiration: string | null;
  created_at: string;
}

function getTokenKey(): Buffer {
  const secret = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY must be set to store Gmail account tokens");
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptRefreshToken(refreshToken: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(TOKEN_ALGORITHM, getTokenKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(refreshToken, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptRefreshToken(encryptedToken: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = encryptedToken.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Invalid Gmail token payload");
  }

  const decipher = createDecipheriv(
    TOKEN_ALGORITHM,
    getTokenKey(),
    Buffer.from(ivRaw, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export async function listEnabledGmailAccounts(): Promise<GmailAccount[]> {
  // System path (poller): lists enabled accounts across ALL tenants by design;
  // each account row carries its own tenant_id used for downstream scoping.
  let data: Array<{
    id: string;
    tenant_id: string;
    email: string;
    refresh_token_encrypted: string;
    enabled: boolean;
  }>;
  try {
    data = await db
      .select({
        id: gmailAccounts.id,
        tenant_id: gmailAccounts.tenant_id,
        email: gmailAccounts.email,
        refresh_token_encrypted: gmailAccounts.refresh_token_encrypted,
        enabled: gmailAccounts.enabled,
      })
      .from(gmailAccounts)
      .where(eq(gmailAccounts.enabled, true))
      .orderBy(asc(gmailAccounts.created_at));
  } catch (err) {
    const code = (err as { code?: string })?.code;
    // 42P01 = undefined_table — the migration has not run yet; stay silent.
    if (code !== "42P01") {
      console.error("[gmail-accounts] list enabled error:", code ?? "unknown");
    }
    return [];
  }

  const accounts: GmailAccount[] = [];
  for (const row of data) {
    try {
      accounts.push({
        id: row.id,
        tenantId: row.tenant_id,
        email: row.email,
        refreshToken: decryptRefreshToken(row.refresh_token_encrypted),
        enabled: row.enabled,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "UnknownError";
      console.error("[gmail-accounts] decrypt enabled account error:", name);
    }
  }

  return accounts;
}

/**
 * Returns the single active Gmail account for a tenant.
 * Returns null if no enabled account exists.
 */
export async function getGmailAccountForTenant(
  tenantId: string
): Promise<GmailAccount | null> {
  try {
    const data = firstRow(
      await db
        .select({
          id: gmailAccounts.id,
          tenant_id: gmailAccounts.tenant_id,
          email: gmailAccounts.email,
          refresh_token_encrypted: gmailAccounts.refresh_token_encrypted,
          enabled: gmailAccounts.enabled,
        })
        .from(gmailAccounts)
        .where(
          and(
            eq(gmailAccounts.tenant_id, tenantId),
            eq(gmailAccounts.enabled, true)
          )
        )
        .limit(1)
    );

    if (!data) return null;

    return {
      id: data.id,
      tenantId: data.tenant_id,
      email: data.email,
      refreshToken: decryptRefreshToken(data.refresh_token_encrypted),
      enabled: data.enabled,
    };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "42P01") {
      console.error("[gmail-accounts] fetch for tenant error:", code ?? "unknown");
    }
    return null;
  }
}

export async function getGmailAccountByEmail(
  email: string
): Promise<GmailAccount | null> {
  let data: {
    id: string;
    tenant_id: string;
    email: string;
    refresh_token_encrypted: string;
    enabled: boolean;
  } | null;
  try {
    data = firstRow(
      await db
        .select({
          id: gmailAccounts.id,
          tenant_id: gmailAccounts.tenant_id,
          email: gmailAccounts.email,
          refresh_token_encrypted: gmailAccounts.refresh_token_encrypted,
          enabled: gmailAccounts.enabled,
        })
        .from(gmailAccounts)
        .where(
          and(
            eq(gmailAccounts.email, email.toLowerCase()),
            eq(gmailAccounts.enabled, true)
          )
        )
        .limit(1)
    );
  } catch (err) {
    const code = (err as { code?: string })?.code;
    // 42P01 = undefined_table — the migration has not run yet; stay silent.
    if (code !== "42P01") {
      console.error("[gmail-accounts] fetch by email error:", code ?? "unknown");
    }
    return null;
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id,
    tenantId: data.tenant_id,
    email: data.email,
    refreshToken: decryptRefreshToken(data.refresh_token_encrypted),
    enabled: data.enabled,
  };
}
