/**
 * /api/admin/fine-tuning/vertex/:id — single Vertex AI tuning job operations.
 *
 * GET  — get a single Vertex AI job by ID
 * POST — activate the tuned model (action="activate")
 *         or rollback to the previous model (action="rollback")
 */

import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  getVertexAiTuningJob,
  activateVertexAiModel,
  rollbackVertexAiModel,
} from "@/server/training/vertex-ai-fine-tuning";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const PostSchema = z.object({
  action: z.enum(["activate", "rollback"]),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { userRow } = await requireAdmin();
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("NOT_FOUND");

    const job = await getVertexAiTuningJob(userRow.tenant_id, params.data.id);
    if (!job) throw new AppError("NOT_FOUND");

    return ok({ job });
  } catch (e) {
    return err(e);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { user, userRow } = await requireAdmin();
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("NOT_FOUND");

    const parsed = PostSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { action } = parsed.data;

    if (action === "activate") {
      try {
        const result = await activateVertexAiModel(
          userRow.tenant_id,
          user.id,
          params.data.id
        );
        return ok({ result });
      } catch (e) {
        const message = e instanceof Error ? e.message : "";
        if (message === "VERTEX_AI_TUNING_DISABLED") {
          throw new AppError("VALIDATION_FAILED", "Vertex AI fine-tuning is not enabled.");
        }
        if (["NOT_FOUND", "NO_MODEL"].includes(message)) {
          throw new AppError("NOT_FOUND");
        }
        if (message === "WRONG_PROVIDER") {
          throw new AppError("VALIDATION_FAILED", "Este trabajo no es de Vertex AI.");
        }
        if (message === "JOB_NOT_APPROVED") {
          throw new AppError(
            "VALIDATION_FAILED",
            "Aprobá la evaluación antes de activar el modelo."
          );
        }
        throw e;
      }
    }

    // action === "rollback"
    try {
      const result = await rollbackVertexAiModel(userRow.tenant_id, user.id);
      return ok({ result });
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (message === "VERTEX_AI_TUNING_DISABLED") {
        throw new AppError("VALIDATION_FAILED", "Vertex AI fine-tuning is not enabled.");
      }
      throw e;
    }
  } catch (e) {
    return err(e);
  }
}
