import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

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

export async function listEnabledGmailAccounts(
  supabase: SupabaseClient
): Promise<GmailAccount[]> {
  const { data, error } = await (supabase as any)
    .from("gmail_accounts")
    .select("id,tenant_id,email,refresh_token_encrypted,enabled")
    .eq("enabled", true)
    .order("created_at", { ascending: true });

  if (error || !data) {
    if (error?.code !== "42P01") {
      console.error("[gmail-accounts] list enabled error:", error?.code ?? "unknown");
    }
    return [];
  }

  const accounts: GmailAccount[] = [];
  for (const row of data as Array<{
    id: string;
    tenant_id: string;
    email: string;
    refresh_token_encrypted: string;
    enabled: boolean;
  }>) {
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

export async function getGmailAccountByEmail(
  supabase: SupabaseClient,
  email: string
): Promise<GmailAccount | null> {
  const { data, error } = await (supabase as any)
    .from("gmail_accounts")
    .select("id,tenant_id,email,refresh_token_encrypted,enabled")
    .eq("email", email.toLowerCase())
    .eq("enabled", true)
    .maybeSingle();

  if (error || !data) {
    if (error?.code !== "42P01") {
      console.error("[gmail-accounts] fetch by email error:", error?.code ?? "unknown");
    }
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

