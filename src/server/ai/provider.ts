/**
 * AI provider selection — per-tenant switch between OpenAI and Google Gemini.
 *
 * The active provider is resolved in this order:
 *   1. MOCK_AI / AI_MOCK env → "mock" (demo mode, no real LLM calls)
 *   2. tenant_ai_settings.provider for the tenant (set from Configuración)
 *   3. AI_PROVIDER env var
 *   4. default "gemini"
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
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";

export type AiProvider = "openai" | "gemini";
export type ExtractionEngine = AiProvider | "mock";

export const AI_PROVIDERS: readonly AiProvider[] = ["gemini", "openai"] as const;
const DEFAULT_AI_PROVIDER: AiProvider = "gemini";

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
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  if (userId) {
    const userKey = await getUserGeminiKey(userId);
    if (userKey) return userKey;
  }
  try {
    const row = await enTenant(tenantCtx, (db) =>
      db
        .select({ enc: tables.tenantAiSettings.gemini_api_key_encrypted })
        .from(tables.tenantAiSettings)
        .limit(1)
        .then(firstRow)
    );
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
      provider: DEFAULT_AI_PROVIDER,
      active_model_provider: DEFAULT_AI_PROVIDER,
      active_model: null,
      gemini_model: getDefaultGeminiModel(),
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

export function getDefaultOpenAIModel(): string {
  return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
}

export function getDefaultGeminiModel(): string {
  // gemini-flash-latest (not a pinned 2.5/2.0 name): pinned older models get
  // "no longer available to new users" 404s on freshly-created keys. -latest
  // always resolves to the current Flash, immune to that deprecation trap.
  return process.env.GEMINI_MODEL ?? "gemini-flash-latest";
}

export async function getTenantOpenAIModel(tenantId?: string | null): Promise<string> {
  if (!tenantId) return getDefaultOpenAIModel();
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const row = await enTenant(tenantCtx, (db) =>
      db
        .select({
          openai_model: tables.tenantAiSettings.openai_model,
          active_model_provider: tables.tenantAiSettings.active_model_provider,
          active_model: tables.tenantAiSettings.active_model,
        })
        .from(tables.tenantAiSettings)
        .limit(1)
        .then(firstRow)
    );

    if (row?.active_model_provider === "openai" && row.active_model?.trim()) {
      return row.active_model.trim();
    }
    return row?.openai_model?.trim() || getDefaultOpenAIModel();
  } catch {
    return getDefaultOpenAIModel();
  }
}

export async function getTenantGeminiModel(tenantId?: string | null): Promise<string> {
  if (!tenantId) return getDefaultGeminiModel();
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const row = await enTenant(tenantCtx, (db) =>
      db
        .select({
          gemini_model: tables.tenantAiSettings.gemini_model,
          active_model_provider: tables.tenantAiSettings.active_model_provider,
          active_model: tables.tenantAiSettings.active_model,
        })
        .from(tables.tenantAiSettings)
        .limit(1)
        .then(firstRow)
    );

    if (row?.active_model_provider === "gemini" && row.active_model?.trim()) {
      return row.active_model.trim();
    }
    return row?.gemini_model?.trim() || getDefaultGeminiModel();
  } catch {
    return getDefaultGeminiModel();
  }
}

export async function setTenantModelDefaults(
  tenantId: string,
  values: { provider?: AiProvider; openaiModel?: string; geminiModel?: string }
): Promise<void> {
  const t = tables.tenantAiSettings;
  const now = new Date().toISOString();
  const provider = values.provider ?? DEFAULT_AI_PROVIDER;
  const insertValues = {
    tenant_id: tenantId,
    provider,
    openai_model: values.openaiModel?.trim() || getDefaultOpenAIModel(),
    gemini_model: values.geminiModel?.trim() || getDefaultGeminiModel(),
    active_model_provider: provider,
    active_model: null,
    updated_at: now,
  };
  await db
    .insert(t)
    .values(insertValues)
    .onConflictDoUpdate({
      target: t.tenant_id,
      set: {
        ...(values.provider
          ? {
              provider: values.provider,
              active_model_provider: values.provider,
              active_model: null,
            }
          : {}),
        ...(values.openaiModel ? { openai_model: values.openaiModel.trim() } : {}),
        ...(values.geminiModel ? { gemini_model: values.geminiModel.trim() } : {}),
        updated_at: now,
      },
    });
}

/** True when the provider has a usable API key (user → tenant → env). */
export async function hasProviderKeyForTenant(tenantId: string, provider: AiProvider, userId?: string): Promise<boolean> {
  if (provider === "openai") return hasProviderKey("openai");

  // Vertex authenticates with a service account, not an API key, so asking for
  // an API key answers the wrong question.
  //
  // This failed silently and completely. A rehearsal ran with the Vertex
  // credentials and no GEMINI_API_KEY: the resolver decided Gemini was
  // unavailable, then that OpenAI was unavailable, and fell all the way
  // through to the mock extractor. Twelve conversations were rehearsed against
  // canned data and reported as the agent's behaviour.
  //
  // Production happens to carry a leftover GEMINI_API_KEY, which is the only
  // reason it was not doing the same thing — an insurer's deployment quietly
  // answering claimants with mock output is about the worst outcome this
  // codebase has available, and one unused environment variable was standing
  // between us and it.
  if (isVertexConfigured()) return true;

  return Boolean(await getTenantGeminiKey(tenantId, userId));
}

/** Vertex is usable when the transport is on and the project is named. */
export function isVertexConfigured(): boolean {
  if (process.env.GEMINI_TRANSPORT?.trim().toLowerCase() !== "vertex") return false;
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT?.trim());
}

/** Env-level default provider (AI_PROVIDER, default "gemini"). */
export function getDefaultProvider(): AiProvider {
  const env = process.env.AI_PROVIDER?.trim().toLowerCase();
  return isAiProvider(env) ? env : DEFAULT_AI_PROVIDER;
}

/**
 * The tenant's configured provider preference (tenant_ai_settings row),
 * falling back to the env default. Never throws.
 */
export async function getTenantAiProvider(
  tenantId: string
): Promise<AiProvider> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const data = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ provider: tables.tenantAiSettings.provider })
          .from(tables.tenantAiSettings)
          .limit(1)
      )
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
