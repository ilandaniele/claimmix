import { NextRequest } from "next/server";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { tables } from "@/lib/db";
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
    const { db, userRow } = await requireAdmin();

    let data;
    try {
      data = await db
        .select(ACCOUNT_COLUMNS)
        .from(t)
        .where(eq(t.tenant_id, userRow.tenant_id))
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
    const { db, userRow } = await requireAdmin();
    const parsed = UpdateGmailAccountSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    let data;
    try {
      data = firstRow(
        await db
          .update(t)
          .set({
            enabled: parsed.data.enabled,
            updated_at: new Date().toISOString(),
          })
          .where(
            and(
              eq(t.id, parsed.data.id),
              eq(t.tenant_id, userRow.tenant_id)
            )
          )
          .returning(ACCOUNT_COLUMNS)
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
    const { db, userRow } = await requireAdmin();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new AppError("VALIDATION_FAILED");

    try {
      await db
        .delete(t)
        .where(and(eq(t.id, id), eq(t.tenant_id, userRow.tenant_id)));
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
