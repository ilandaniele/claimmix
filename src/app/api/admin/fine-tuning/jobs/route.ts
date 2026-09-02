/**
 * /api/admin/fine-tuning/jobs - list and draft fine-tune jobs.
 */

import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  createDraftFineTuneJob,
  listFineTuneJobs,
} from "@/server/training/fine-tuning";

export const dynamic = "force-dynamic";

/*
 * Queda `draft` sola. `rollback` era volver a un modelo fine-tuned anterior de
 * OpenAI: escribia `provider: "openai"` en la configuracion del inquilino, un
 * valor que el producto ya no sabe leer.
 */
const PostSchema = z.object({
  action: z.enum(["draft"]).default("draft"),
});

export async function GET() {
  try {
    const { userRow } = await requireAdmin();
    const jobs = await listFineTuneJobs(userRow.tenant_id);
    return ok({ jobs });
  } catch (e) {
    return err(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, userRow } = await requireAdmin();
    const parsed = PostSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    try {
      const job = await createDraftFineTuneJob(userRow.tenant_id, user.id);
      return ok({ job }, 201);
    } catch (e) {
      if (e instanceof Error && e.message === "NO_APPROVED_EXAMPLES") {
        throw new AppError(
          "VALIDATION_FAILED",
          "Necesitás al menos un ejemplo aprobado para crear un trabajo."
        );
      }
      throw e;
    }
  } catch (e) {
    return err(e);
  }
}
