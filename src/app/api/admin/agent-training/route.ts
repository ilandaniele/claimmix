import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

const TRAINING_TITLE = "Email intake agent training";

const UpdateAgentTrainingSchema = z.object({
  content: z.string().max(20_000),
  enabled: z.boolean().default(true),
});

export async function GET() {
  try {
    const { supabase, userRow } = await requireAdmin();

    const { data, error } = await (supabase as any)
      .from("agent_training")
      .select("id,title,content,enabled,updated_at")
      .eq("tenant_id", userRow.tenant_id)
      .eq("title", TRAINING_TITLE)
      .maybeSingle();

    if (error) {
      console.error("[admin/agent-training GET]", error.code);
      return err("INTERNAL_ERROR");
    }

    return ok({
      training: data ?? {
        id: null,
        title: TRAINING_TITLE,
        content: "",
        enabled: true,
        updated_at: null,
      },
    });
  } catch (e) {
    return err(e);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { supabase, user, userRow } = await requireAdmin();
    const body = await request.json();
    const parsed = UpdateAgentTrainingSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const payload = {
      tenant_id: userRow.tenant_id,
      title: TRAINING_TITLE,
      content: parsed.data.content.trim(),
      enabled: parsed.data.enabled,
      updated_by: user.id,
    };

    const { data, error } = await (supabase as any)
      .from("agent_training")
      .upsert(payload, { onConflict: "tenant_id,title" })
      .select("id,title,content,enabled,updated_at")
      .single();

    if (error || !data) {
      console.error("[admin/agent-training PUT]", error?.code ?? "no_data");
      return err("INTERNAL_ERROR");
    }

    return ok({ training: data });
  } catch (e) {
    return err(e);
  }
}
