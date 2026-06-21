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
  rollbackFineTunedModel,
} from "@/server/training/fine-tuning";
import { getTenantAiProvider } from "@/server/ai/provider";

export const dynamic = "force-dynamic";

const PostSchema = z.object({
  action: z.enum(["draft", "rollback"]).default("draft"),
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

    const provider = await getTenantAiProvider(userRow.tenant_id);
    if (parsed.data.action === "rollback") {
      if (provider !== "openai") {
        throw new AppError(
          "VALIDATION_FAILED",
          "Rollback solo aplica a modelos fine-tuned de OpenAI. Gemini usa paquetes contextuales."
        );
      }
      const result = await rollbackFineTunedModel(userRow.tenant_id, user.id);
      return ok({ result });
    }

    try {
      const job = await createDraftFineTuneJob(userRow.tenant_id, user.id, provider);
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
