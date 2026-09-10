import { NextRequest } from "next/server";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { requireRole, ADMIN_ROLES, ALL_ROLES } from "@/lib/auth/require-role";
import { tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";

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

export async function GET() {
  try {
    const { user, userRow } = await requireRole(...ALL_ROLES);
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const isAdmin = userRow.role === "admin" || userRow.role === "owner";

    let data;
    try {
      data = await enTenant(tenantCtx, (db) =>
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
    const { user, userRow } = await requireRole(...ADMIN_ROLES);
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const isAdmin = userRow.role === "admin" || userRow.role === "owner";
    const parsed = UpdateGmailAccountSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    let data;
    try {
      data = firstRow(
        await enTenant(tenantCtx, (db) =>
          db
            .update(t)
            .set({
              enabled: parsed.data.enabled,
              updated_at: new Date().toISOString(),
            })
            .where(eq(t.id, parsed.data.id))
            .returning(ACCOUNT_COLUMNS)
        )
      );
    } catch (e) {
      logger.error({ detalle: (e as { code?: string })?.code ?? "unknown" }, "admin_gmail_accounts_patch");
      return err("INTERNAL_ERROR");
    }

    if (!data) {
      logger.error({ detalle: "no_data" }, "admin_gmail_accounts_patch");
      return err("INTERNAL_ERROR");
    }

    return ok({ account: data });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { user, userRow } = await requireRole(...ADMIN_ROLES);
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const isAdmin = userRow.role === "admin" || userRow.role === "owner";
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new AppError("VALIDATION_FAILED");

    try {
      await enTenant(tenantCtx, (db) =>
        db.delete(t).where(eq(t.id, id))
      );
    } catch (e) {
      logger.error({ detalle: (e as { code?: string })?.code ?? "unknown" }, "admin_gmail_accounts_delete");
      return err("INTERNAL_ERROR");
    }

    return ok({ id });
  } catch (e) {
    return err(e);
  }
}
