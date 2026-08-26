import { NextRequest } from "next/server";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { requireRole, ADMIN_ROLES, ALL_ROLES } from "@/lib/auth/require-role";
import { tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

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
    const { db, user, userRow } = await requireRole(...ALL_ROLES);
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const isAdmin = userRow.role === "admin" || userRow.role === "owner";

    let data;
    try {
      data = await db
        .select(ACCOUNT_COLUMNS)
        .from(t)
        .where(
          isAdmin
            ? eq(t.tenant_id, userRow.tenant_id)
            : and(eq(t.tenant_id, userRow.tenant_id), eq(t.connected_by, user.id))
        )
        .orderBy(asc(t.created_at));
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "42P01") return ok({ accounts: [] });
      console.error("[admin/gmail-accounts GET]", code ?? "unknown");
      return err("INTERNAL_ERROR");
    }

    return ok({ accounts: data ?? [] });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { db, user, userRow } = await requireRole(...ADMIN_ROLES);
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
            .where(
              isAdmin
                ? eq(t.id, parsed.data.id)
                : and(eq(t.id, parsed.data.id), eq(t.tenant_id, userRow.tenant_id), eq(t.connected_by, user.id))
            )
            .returning(ACCOUNT_COLUMNS)
        )
      );
    } catch (e) {
      console.error(
        "[admin/gmail-accounts PATCH]",
        (e as { code?: string })?.code ?? "unknown"
      );
      return err("INTERNAL_ERROR");
    }

    if (!data) {
      console.error("[admin/gmail-accounts PATCH]", "no_data");
      return err("INTERNAL_ERROR");
    }

    return ok({ account: data });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { db, user, userRow } = await requireRole(...ADMIN_ROLES);
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const isAdmin = userRow.role === "admin" || userRow.role === "owner";
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new AppError("VALIDATION_FAILED");

    try {
      await enTenant(tenantCtx, (db) =>
        db
          .delete(t)
          .where(
            isAdmin
              ? eq(t.id, id)
              : and(eq(t.id, id), eq(t.tenant_id, userRow.tenant_id), eq(t.connected_by, user.id))
          )
      );
    } catch (e) {
      console.error(
        "[admin/gmail-accounts DELETE]",
        (e as { code?: string })?.code ?? "unknown"
      );
      return err("INTERNAL_ERROR");
    }

    return ok({ id });
  } catch (e) {
    return err(e);
  }
}
