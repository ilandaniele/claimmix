/**
 * Qué motor extrae, y con qué clave.
 *
 * Queda un solo proveedor real —Gemini— y el mock. El tipo `AiProvider` sigue
 * existiendo con un miembro: es lo que hace que agregar otro sea cambiar una
 * unión y que el compilador marque los lugares, en vez de buscar strings
 * sueltos por el repo. Fue así como se sacó OpenAI.
 *
 * El orden es:
 *   1. MOCK_AI / AI_MOCK → "mock" (demo, sin llamadas de verdad)
 *   2. tenant_ai_settings.provider del inquilino
 *   3. AI_PROVIDER
 *   4. "gemini"
 *
 * Defensivo de punta a punta: si falta la tabla `tenant_ai_settings` —la
 * migración no aplicada— o la consulta falla, se cae al default del entorno en
 * vez de romper.
 *
 * Un valor guardado que ya no exista —`"openai"`, de antes— NO rompe: no pasa
 * `isAiProvider` y cae al default. Producción no tiene ninguno, pero la
 * columna es `text` y eso no lo garantiza nadie.
 */

import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";

export type AiProvider = "gemini";
export type ExtractionEngine = AiProvider | "mock";

export const AI_PROVIDERS: readonly AiProvider[] = ["gemini"] as const;
const DEFAULT_AI_PROVIDER: AiProvider = "gemini";

function isAiProvider(value: unknown): value is AiProvider {
  return value === "gemini";
}

// ── Key encryption (AES-256-GCM, same as Gmail token storage) ────────────────

const KEY_ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const secret = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY must be set to store API keys");
  return createHash("sha256").update(secret).digest();
}

/*
 * El largo de la etiqueta se fija a mano, y no es cosmético.
 *
 * En GCM la etiqueta de autenticación es lo único que distingue un texto
 * cifrado legítimo de uno fabricado. Node, si no se le dice el largo, acepta
 * al descifrar etiquetas de 4, 8, 12, 13, 14, 15 o 16 bytes: quien pueda
 * escribir el texto cifrado guardado puede mandar una de 4 bytes y bajar el
 * costo de falsificarla de 2^128 a 2^32, que es un rato de CPU.
 *
 * Acá adentro viaja el token de Gmail —el permiso permanente para leer y
 * escribir en la casilla— así que el largo se declara en los dos lados y una
 * etiqueta de otro tamaño se rechaza antes de intentar descifrar.
 *
 * Compatible con lo ya guardado: `getAuthTag()` viene devolviendo 16 bytes,
 * que es el valor por omisión. Esto no cambia lo que se escribe; cierra lo
 * que se acepta.
 */
const TAG_BYTES = 16;

function encryptApiKey(key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(KEY_ALGORITHM, getEncryptionKey(), iv, {
    authTagLength: TAG_BYTES,
  });
  const encrypted = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString("base64url")).join(".");
}

function decryptApiKey(encryptedKey: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = encryptedKey.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid API key payload");
  const tag = Buffer.from(tagRaw, "base64url");
  if (tag.length !== TAG_BYTES) throw new Error("Invalid API key payload");
  const decipher = createDecipheriv(
    KEY_ALGORITHM,
    getEncryptionKey(),
    Buffer.from(ivRaw, "base64url"),
    { authTagLength: TAG_BYTES }
  );
  decipher.setAuthTag(tag);
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
    // sin-inquilino: `user_ai_settings` no tiene columna de inquilino: la clave es el usuario.
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
  // sin-inquilino: Idem.
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
    ).then(firstRow);
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
  await enTenant({ tenantId }, (db) =>
    db
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
      })
  );
}

// ── Provider key checks ───────────────────────────────────────────────────────

/** True when the provider's API key is configured in env (non-empty). */
export function hasProviderKey(_provider: AiProvider): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function getDefaultGeminiModel(): string {
  // gemini-flash-latest (not a pinned 2.5/2.0 name): pinned older models get
  // "no longer available to new users" 404s on freshly-created keys. -latest
  // always resolves to the current Flash, immune to that deprecation trap.
  return process.env.GEMINI_MODEL ?? "gemini-flash-latest";
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
    ).then(firstRow);

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
  values: { provider?: AiProvider; geminiModel?: string }
): Promise<void> {
  const t = tables.tenantAiSettings;
  const now = new Date().toISOString();
  const provider = values.provider ?? DEFAULT_AI_PROVIDER;
  const insertValues = {
    tenant_id: tenantId,
    provider,
    gemini_model: values.geminiModel?.trim() || getDefaultGeminiModel(),
    active_model_provider: provider,
    active_model: null,
    updated_at: now,
  };
  await enTenant({ tenantId }, (db) =>
    db
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
          ...(values.geminiModel ? { gemini_model: values.geminiModel.trim() } : {}),
          updated_at: now,
        },
      })
  );
}

/** True when the provider has a usable API key (user → tenant → env). */
export async function hasProviderKeyForTenant(tenantId: string, _provider: AiProvider, userId?: string): Promise<boolean> {
  // Vertex autentica con una cuenta de servicio, no con una API key, así que
  // preguntar por una API key contesta la pregunta equivocada.
  //
  // Esto falló en silencio y por completo. Un ensayo corrió con las
  // credenciales de Vertex y sin GEMINI_API_KEY: el resolvedor decidió que
  // Gemini no estaba disponible, después que OpenAI tampoco, y se cayó hasta
  // el extractor mock. Doce conversaciones ensayadas contra datos inventados y
  // reportadas como el comportamiento del agente.
  //
  // Producción tenía de casualidad una GEMINI_API_KEY vieja, y esa es la única
  // razón por la que no estaba haciendo lo mismo: el deploy de una aseguradora
  // contestándole a sus asegurados con salida del mock es lo peor que este
  // repo tiene disponible, y una variable de entorno sin usar era todo lo que
  // se interponía.
  //
  // El paso del medio —«después que OpenAI tampoco»— ya no existe: queda un
  // solo proveedor, así que si esta función devuelve false se va derecho al
  // mock. Por eso `resolveExtractionEngine` ahora lo registra.
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
 * Qué motor corre de verdad para este inquilino. Orden de la clave: usuario →
 * inquilino → entorno.
 *
 * ⚠️ Caer al mock es lo peor que puede pasar acá, y es silencioso por diseño
 * del tipo de retorno: nada explota, el caso se procesa, y el asegurado recibe
 * una respuesta armada con datos inventados. Ya pasó una vez —un ensayo entero
 * corrió contra el mock y se reportó como el comportamiento del agente— y lo
 * único que separaba a producción de lo mismo era una `GEMINI_API_KEY` vieja
 * que nadie estaba usando.
 *
 * Mientras hubo dos proveedores, el aviso salía al cambiar de uno al otro y la
 * caída al mock no avisaba nada. Ahora que queda uno, la caída al mock es la
 * ÚNICA degradación posible, así que es la que tiene que gritar.
 *
 * El comportamiento no cambia —sigue devolviendo "mock" en vez de tirar—
 * porque decidir que un caso se caiga en vez de contestar con datos falsos es
 * una decisión de producto, no una limpieza. Pero ahora queda en el log.
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

  console.warn(
    JSON.stringify({
      level: "warn",
      service: "claimmix",
      msg: "ai.provider.degraded_to_mock",
      tenant_id: tenantId,
      preferred,
      reason: "missing_api_key",
      detalle:
        "Sin credencial utilizable para Gemini. Las extracciones salen del mock: " +
        "son datos inventados y NO sirven para contestarle a un asegurado.",
    })
  );
  return "mock";
}
