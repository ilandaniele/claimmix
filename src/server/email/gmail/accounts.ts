import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { gmailAccounts } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";
import { logger } from "@/lib/observability/logger";
import { cifrar, descifrar } from "@/lib/security/cifrado";

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

export function encryptRefreshToken(refreshToken: string): string {
  return cifrar(refreshToken);
}

export function decryptRefreshToken(encryptedToken: string): string {
  return descifrar(encryptedToken, "Invalid Gmail token payload");
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
      logger.error({ detalle: code ?? "unknown" }, "gmail_accounts.list_enabled_error");
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
      logger.error({ error_name: name }, "gmail_accounts.decrypt_enabled_account_error");
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
      logger.error({ detalle: code ?? "unknown" }, "gmail_accounts.fetch_for_tenant_error");
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
      logger.error({ detalle: code ?? "unknown" }, "gmail_accounts.fetch_by_email_error");
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
