/**
 * /api/admin/fine-tuning/vertex — Vertex AI Gemini fine-tuning job collection.
 *
 * GET  — list Vertex AI jobs for the authenticated admin's tenant
 * POST — create draft (action="draft"), start a job (action="start"),
 *         or sync job status (action="sync")
 */

import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  listVertexAiTuningJobs,
  createVertexAiTuningDraft,
  startVertexAiTuningJob,
  syncVertexAiTuningJobStatus,
  getVertexAiConfig,
} from "@/server/training/vertex-ai-fine-tuning";

export const dynamic = "force-dynamic";

const PostSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft") }),
  z.object({ action: z.literal("start"), jobId: z.string().uuid() }),
  z.object({ action: z.literal("sync"), jobId: z.string().uuid() }),
]);

export async function GET() {
  try {
    const { userRow } = await requireAdmin();
    const [jobs, config] = await Promise.all([
      listVertexAiTuningJobs(userRow.tenant_id),
      Promise.resolve(getVertexAiConfig()),
    ]);
    return ok({ jobs, config });
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

    const { action } = parsed.data;

    if (action === "draft") {
      try {
        const job = await createVertexAiTuningDraft(userRow.tenant_id, user.id);
        return ok({ job }, 201);
      } catch (e) {
        const message = e instanceof Error ? e.message : "";
        if (message === "VERTEX_AI_TUNING_DISABLED") {
          throw new AppError("VALIDATION_FAILED", "Vertex AI fine-tuning is not enabled.");
        }
        if (message.startsWith("NOT_ENOUGH_EXAMPLES")) {
          const min = message.split(":")[1] ?? "10";
          throw new AppError(
            "VALIDATION_FAILED",
            `Necesitás al menos ${min} ejemplos aprobados para entrenar con Vertex AI.`
          );
        }
        throw e;
      }
    }

    if (action === "start") {
      const { jobId } = parsed.data;
      try {
        const job = await startVertexAiTuningJob(userRow.tenant_id, user.id, jobId);
        return ok({ job });
      } catch (e) {
        const message = e instanceof Error ? e.message : "";
        if (message === "VERTEX_AI_TUNING_DISABLED") {
          throw new AppError("VALIDATION_FAILED", "Vertex AI fine-tuning is not enabled.");
        }
        if (message === "NOT_FOUND") throw new AppError("NOT_FOUND");
        if (message === "WRONG_PROVIDER") {
          throw new AppError("VALIDATION_FAILED", "Este trabajo no es de Vertex AI.");
        }
        if (message === "JOB_NOT_STARTABLE") {
          throw new AppError("VALIDATION_FAILED", "Este trabajo ya fue iniciado o no puede iniciarse.");
        }
        if (message.startsWith("NOT_ENOUGH_EXAMPLES")) {
          const min = message.split(":")[1] ?? "10";
          throw new AppError(
            "VALIDATION_FAILED",
            `Necesitás al menos ${min} ejemplos aprobados para iniciar el entrenamiento.`
          );
        }
        throw e;
      }
    }

    // action === "sync"
    const { jobId } = parsed.data;
    try {
      const job = await syncVertexAiTuningJobStatus(userRow.tenant_id, user.id, jobId);
      return ok({ job });
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (message === "VERTEX_AI_TUNING_DISABLED") {
        throw new AppError("VALIDATION_FAILED", "Vertex AI fine-tuning is not enabled.");
      }
      if (message === "NOT_FOUND") throw new AppError("NOT_FOUND");
      if (message === "WRONG_PROVIDER") {
        throw new AppError("VALIDATION_FAILED", "Este trabajo no es de Vertex AI.");
      }
      if (message === "VERTEX_JOB_NOT_STARTED") {
        throw new AppError("VALIDATION_FAILED", "El trabajo todavía no fue enviado a Vertex AI.");
      }
      throw e;
    }
  } catch (e) {
    return err(e);
  }
}
