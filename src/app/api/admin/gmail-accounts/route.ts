import { NextRequest } from "next/server";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { requireRole, ADMIN_ROLES, ALL_ROLES } from "@/lib/auth/require-role";
import { tables } from "@/lib/db";
import { enControl, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { errorCode } from "@/lib/observability/error-code";
import { decryptRefreshToken } from "@/server/email/gmail/accounts";
import { setupGmailWatch, stopGmailWatch } from "@/server/email/gmail/watch";

const UpdateGmailAccountSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
});

const t = tables.gmailAccounts;

const ACCOUNT_COLUMNS = {
  id: t.id,
  email: t.email,
  enabled: t.enabled,
  last_connected_at: t.last_connected_at,
  last_error: t.last_error,
  created_at: t.created_at,
};

/**
 * Acomoda el aviso de Gmail al nuevo `enabled`: apagado, Google deja de mandar
 * avisos de una casilla que el poller ya no lee; prendido, se vuelve a pedir
 * (el watch vence a la semana y el cron sólo renueva las habilitadas).
 *
 * Las dos llamadas son idempotentes, así que no hace falta saber si `enabled`
 * cambió. Un fallo no revierte el UPDATE: la casilla queda como se pidió y el
 * cron la alcanza o la deja de leer.
 */
async function ajustarElWatch(email: string, tokenCifrado: string, enabled: boolean): Promise<void> {
  const topic = process.env.PUBSUB_TOPIC;
  if (enabled && !topic) return;
  try {
    const cuenta = { email, refreshToken: decryptRefreshToken(tokenCifrado) };
    if (enabled && topic) {
      await setupGmailWatch(topic, cuenta);
      return;
    }
    await stopGmailWatch(cuenta);
  } catch (e) {
    logger.error({ detalle: errorCode(e) }, "gmail_accounts.watch_no_cambiado");
  }
}

export async function GET() {
  try {
    const { user, userRow } = await requireRole(...ALL_ROLES);
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const isAdmin = userRow.role === "admin" || userRow.role === "owner";

    let data;
    try {
      data = await enControl(tenantCtx, (db) =>
        db
          .select(ACCOUNT_COLUMNS)
          .from(t)
          .where(
            isAdmin
              ? eq(t.tenant_id, userRow.tenant_id)
              : and(eq(t.tenant_id, userRow.tenant_id), eq(t.connected_by, user.id))
          )
          .orderBy(asc(t.created_at))
      );
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "42P01") return ok({ accounts: [] });
      logger.error({ detalle: code ?? "unknown" }, "admin_gmail_accounts_get");
      return err("INTERNAL_ERROR");
    }

    return ok({ accounts: data ?? [] });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { userRow } = await requireRole(...ADMIN_ROLES);
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const body = await request.json().catch(() => null);
    const parsed = UpdateGmailAccountSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    let data;
    try {
      data = firstRow(
        await enControl(tenantCtx, (db) =>
          db
            .update(t)
            .set({
              enabled: parsed.data.enabled,
              updated_at: new Date().toISOString(),
            })
            .where(eq(t.id, parsed.data.id))
            // El token cifrado es sólo para el servidor: no sale en la respuesta.
            .returning({ ...ACCOUNT_COLUMNS, refresh_token_encrypted: t.refresh_token_encrypted })
        )
      );
    } catch (e) {
      logger.error({ detalle: (e as { code?: string })?.code ?? "unknown" }, "admin_gmail_accounts_patch");
      return err("INTERNAL_ERROR");
    }

    if (!data) {
      throw new AppError("NOT_FOUND");
    }

    const { refresh_token_encrypted, ...account } = data;
    await ajustarElWatch(account.email, refresh_token_encrypted, parsed.data.enabled);

    return ok({ account });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { userRow } = await requireRole(...ADMIN_ROLES);
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const parsedId = z.string().uuid().safeParse(new URL(request.url).searchParams.get("id"));
    if (!parsedId.success) throw new AppError("NOT_FOUND");
    const id = parsedId.data;

    let deleted;
    try {
      deleted = firstRow(
        await enControl(tenantCtx, (db) =>
          db.delete(t).where(eq(t.id, id)).returning({ id: t.id })
        )
      );
    } catch (e) {
      logger.error({ detalle: (e as { code?: string })?.code ?? "unknown" }, "admin_gmail_accounts_delete");
      return err("INTERNAL_ERROR");
    }

    if (!deleted) throw new AppError("NOT_FOUND");

    return ok({ id });
  } catch (e) {
    return err(e);
  }
}
