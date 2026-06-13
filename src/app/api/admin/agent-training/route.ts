import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { tables } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

const TRAINING_TITLE = "Email intake agent training";

const UpdateAgentTrainingSchema = z.object({
  content: z.string().max(20_000),
  enabled: z.boolean().default(true),
});

const t = tables.agentTraining;

const TRAINING_COLUMNS = {
  id: t.id,
  title: t.title,
  content: t.content,
  enabled: t.enabled,
  updated_at: t.updated_at,
};

export async function GET() {
  try {
    const { db, userRow } = await requireAdmin();

    let data;
    try {
      data = firstRow(
        await db
          .select(TRAINING_COLUMNS)
          .from(t)
          .where(
            and(
              eq(t.tenant_id, userRow.tenant_id),
              eq(t.title, TRAINING_TITLE)
            )
          )
          .limit(1)
      );
    } catch (e) {
      console.error(
        "[admin/agent-training GET]",
        (e as { code?: string })?.code ?? "unknown"
      );
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
    const { db, user, userRow } = await requireAdmin();
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

    let data;
    try {
      data = firstRow(
        await db
          .insert(t)
          .values(payload)
          .onConflictDoUpdate({
            target: [t.tenant_id, t.title],
            set: {
              content: payload.content,
              enabled: payload.enabled,
              updated_by: payload.updated_by,
            },
          })
          .returning(TRAINING_COLUMNS)
      );
    } catch (e) {
      console.error(
        "[admin/agent-training PUT]",
        (e as { code?: string })?.code ?? "unknown"
      );
      return err("INTERNAL_ERROR");
    }

    if (!data) {
      console.error("[admin/agent-training PUT]", "no_data");
      return err("INTERNAL_ERROR");
    }

    return ok({ training: data });
  } catch (e) {
    return err(e);
  }
}
