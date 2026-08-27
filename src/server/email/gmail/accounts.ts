import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
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

export function encryptRefreshToken(refreshToken: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(TOKEN_ALGORITHM, getTokenKey(), iv, {
    authTagLength: TAG_BYTES,
  });
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

  const tag = Buffer.from(tagRaw, "base64url");
  if (tag.length !== TAG_BYTES) {
    throw new Error("Invalid Gmail token payload");
  }

  const decipher = createDecipheriv(
    TOKEN_ALGORITHM,
    getTokenKey(),
    Buffer.from(ivRaw, "base64url"),
    { authTagLength: TAG_BYTES }
  );
  decipher.setAuthTag(tag);
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
    // sin-inquilino: El poller mira TODAS las casillas, de todos los inquilinos, a
    // propósito: cada fila trae su propio tenant_id y con ése se sigue.
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
 * Returns the default active Gmail account for a tenant.
 * Returns null if no enabled account exists.
 *
 * The ORDER BY is not cosmetic. A tenant can have several mailboxes connected,
 * and `limit(1)` with no ordering asks Postgres for "any row" — which it
 * honours, returning whatever the heap hands over first. Reconnecting one
 * account rewrote its row, changed the physical order, and the very next reply
 * to a claimant went out from a different mailbox than every reply before it.
 * Oldest-connected wins: arbitrary, but the same arbitrary answer every time.
 *
 * Callers that know which mailbox received the message should use
 * getGmailAccountByEmail instead — replying from the address someone wrote to
 * beats replying from the tenant default.
 */
export async function getGmailAccountForTenant(
  tenantId: string
): Promise<GmailAccount | null> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const data = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({
            id: gmailAccounts.id,
            tenant_id: gmailAccounts.tenant_id,
            email: gmailAccounts.email,
            refresh_token_encrypted: gmailAccounts.refresh_token_encrypted,
            enabled: gmailAccounts.enabled,
          })
          .from(gmailAccounts)
          .where(
            eq(gmailAccounts.enabled, true)
          )
          .orderBy(asc(gmailAccounts.created_at), asc(gmailAccounts.id))
          .limit(1)
      )
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
      // sin-inquilino: Resuelve una casilla por su dirección de correo, que es única en
      // toda la base. Todavía no se sabe de qué inquilino es: eso sale de acá.
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
