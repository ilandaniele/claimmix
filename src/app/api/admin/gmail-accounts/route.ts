import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

const UpdateGmailAccountSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
});

export async function GET() {
  try {
    const { supabase, userRow } = await requireAdmin();
    const { data, error } = await (supabase as any)
      .from("gmail_accounts")
      .select("id,email,enabled,last_connected_at,last_error,created_at")
      .eq("tenant_id", userRow.tenant_id)
      .order("created_at", { ascending: true });

    if (error) {
      if (error.code === "42P01") return ok({ accounts: [] });
      console.error("[admin/gmail-accounts GET]", error.code);
      return err("INTERNAL_ERROR");
    }

    return ok({ accounts: data ?? [] });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { supabase, userRow } = await requireAdmin();
    const parsed = UpdateGmailAccountSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { data, error } = await (supabase as any)
      .from("gmail_accounts")
      .update({
        enabled: parsed.data.enabled,
        updated_at: new Date().toISOString(),
      })
      .eq("id", parsed.data.id)
      .eq("tenant_id", userRow.tenant_id)
      .select("id,email,enabled,last_connected_at,last_error,created_at")
      .single();

    if (error || !data) {
      console.error("[admin/gmail-accounts PATCH]", error?.code ?? "no_data");
      return err("INTERNAL_ERROR");
    }

    return ok({ account: data });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { supabase, userRow } = await requireAdmin();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new AppError("VALIDATION_FAILED");

    const { error } = await (supabase as any)
      .from("gmail_accounts")
      .delete()
      .eq("id", id)
      .eq("tenant_id", userRow.tenant_id);

    if (error) {
      console.error("[admin/gmail-accounts DELETE]", error.code);
      return err("INTERNAL_ERROR");
    }

    return ok({ id });
  } catch (e) {
    return err(e);
  }
}

