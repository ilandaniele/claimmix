/**
 * AI provider selection — per-tenant switch between OpenAI and Google Gemini.
 *
 * The active provider is resolved in this order:
 *   1. MOCK_AI / AI_MOCK env → "mock" (demo mode, no real LLM calls)
 *   2. tenant_ai_settings.provider for the tenant (set from Configuración)
 *   3. AI_PROVIDER env var
 *   4. default "openai"
 *
 * Whatever is selected, a provider without its API key configured is never
 * used: the resolver falls back to the other provider when possible, and to
 * "mock" only when neither key exists (so the pipeline still degrades
 * gracefully instead of crashing).
 *
 * Fully defensive: a missing tenant_ai_settings table (migration not applied)
 * or any query error silently falls back to the env default.
 */

import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";

export type AiProvider = "openai" | "gemini";
export type ExtractionEngine = AiProvider | "mock";

export const AI_PROVIDERS: readonly AiProvider[] = ["openai", "gemini"] as const;

function isAiProvider(value: unknown): value is AiProvider {
  return value === "openai" || value === "gemini";
}

// ── Key encryption (AES-256-GCM, same as Gmail token storage) ────────────────

const KEY_ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const secret = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY must be set to store API keys");
  return createHash("sha256").update(secret).digest();
}

function encryptApiKey(key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(KEY_ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString("base64url")).join(".");
}

function decryptApiKey(encryptedKey: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = encryptedKey.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid API key payload");
  const decipher = createDecipheriv(KEY_ALGORITHM, getEncryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// ── Per-user Gemini key helpers ───────────────────────────────────────────────

/**
 * Returns the Gemini API key for this user from user_ai_settings.
 * Returns null if not set (does NOT fall back to tenant/env).
 */
export async function getUserGeminiKey(userId: string): Promise<string | null> {
  try {
    const row = await db
      .select({ enc: tables.userAiSettings.gemini_api_key_encrypted })
      .from(tables.userAiSettings)
      .where(eq(tables.userAiSettings.user_id, userId))
      .limit(1)
      .then(firstRow);
    if (row?.enc) return decryptApiKey(row.enc);
  } catch {
    // table missing or DB error — fall through
  }
  return null;
}

/** Encrypt and persist a Gemini API key for this user. */
export async function setUserGeminiKey(userId: string, apiKey: string): Promise<void> {
  const encrypted = encryptApiKey(apiKey);
  const t = tables.userAiSettings;
  await db
    .insert(t)
    .values({ user_id: userId, gemini_api_key_encrypted: encrypted, updated_at: new Date().toISOString() })
    .onConflictDoUpdate({
      target: t.user_id,
      set: { gemini_api_key_encrypted: encrypted, updated_at: new Date().toISOString() },
    });
}

// ── Per-tenant Gemini key helpers ─────────────────────────────────────────────

/**
 * Returns the Gemini API key: user key takes precedence, then tenant DB key,
 * then global GEMINI_API_KEY env var.
 */
export async function getTenantGeminiKey(tenantId: string, userId?: string): Promise<string | null> {
  if (userId) {
    const userKey = await getUserGeminiKey(userId);
    if (userKey) return userKey;
  }
  try {
    const row = await db
      .select({ enc: tables.tenantAiSettings.gemini_api_key_encrypted })
      .from(tables.tenantAiSettings)
      .where(eq(tables.tenantAiSettings.tenant_id, tenantId))
      .limit(1)
      .then(firstRow);
    if (row?.enc) return decryptApiKey(row.enc);
  } catch {
    // DB error — fall through to env
  }
  return process.env.GEMINI_API_KEY?.trim() || null;
}

/** Encrypt and persist a Gemini API key for this tenant. */
export async function setTenantGeminiKey(tenantId: string, apiKey: string): Promise<void> {
  const encrypted = encryptApiKey(apiKey);
  const t = tables.tenantAiSettings;
  await db
    .insert(t)
    .values({
      tenant_id: tenantId,
      provider: "openai",
      gemini_api_key_encrypted: encrypted,
      updated_at: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: t.tenant_id,
      set: { gemini_api_key_encrypted: encrypted, updated_at: new Date().toISOString() },
    });
}

// ── Provider key checks ───────────────────────────────────────────────────────

/** True when the provider's API key is configured in env (non-empty). */
export function hasProviderKey(provider: AiProvider): boolean {
  const key =
    provider === "gemini"
      ? process.env.GEMINI_API_KEY
      : process.env.OPENAI_API_KEY;
  return Boolean(key && key.trim());
}

/** True when the provider has a usable API key (user → tenant → env). */
export async function hasProviderKeyForTenant(tenantId: string, provider: AiProvider, userId?: string): Promise<boolean> {
  if (provider === "openai") return hasProviderKey("openai");
  return Boolean(await getTenantGeminiKey(tenantId, userId));
}

/** Env-level default provider (AI_PROVIDER, default "openai"). */
export function getDefaultProvider(): AiProvider {
  const env = process.env.AI_PROVIDER?.trim().toLowerCase();
  return isAiProvider(env) ? env : "openai";
}

/**
 * The tenant's configured provider preference (tenant_ai_settings row),
 * falling back to the env default. Never throws.
 */
export async function getTenantAiProvider(
  tenantId: string
): Promise<AiProvider> {
  try {
    const data = firstRow(
      await db
        .select({ provider: tables.tenantAiSettings.provider })
        .from(tables.tenantAiSettings)
        .where(eq(tables.tenantAiSettings.tenant_id, tenantId))
        .limit(1)
    );

    if (!data) return getDefaultProvider();
    return isAiProvider(data.provider) ? data.provider : getDefaultProvider();
  } catch {
    return getDefaultProvider();
  }
}

/**
 * Resolve which extraction engine to actually run for this tenant/user,
 * accounting for mock mode and which API keys are configured.
 * Resolution order: user key → tenant key → env var.
 */
export async function resolveExtractionEngine(
  tenantId: string,
  userId?: string | null
): Promise<ExtractionEngine> {
  if (process.env.MOCK_AI === "true" || process.env.AI_MOCK === "true") {
    return "mock";
  }

  const uid = userId ?? undefined;
  const preferred = await getTenantAiProvider(tenantId);
  if (await hasProviderKeyForTenant(tenantId, preferred, uid)) return preferred;

  const fallback: AiProvider = preferred === "openai" ? "gemini" : "openai";
  if (await hasProviderKeyForTenant(tenantId, fallback, uid)) {
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "claimmix",
        msg: "ai.provider.fallback",
        preferred,
        used: fallback,
        reason: "missing_api_key",
      })
    );
    return fallback;
  }

  return "mock";
}
