/**
 * /api/admin/fine-tuning/jobs/:id - start, sync, or activate a fine-tune job.
 */

import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  activateFineTunedModel,
  startFineTuneJob,
} from "@/server/training/fine-tuning";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const PatchSchema = z.object({
  /*
   * "sync" y "approve" se fueron con OpenAI. Con un solo proveedor, "sync"
   * hacia lo mismo que "start" —rearmar el paquete— y "approve" no tenia
   * nada que aprobar: el paquete nace aprobado porque no se sube a ningun
   * lado. Eran los pasos de mirar la evaluacion de OpenAI antes de activar.
   */
  action: z.enum(["start", "activate"]),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { user, userRow } = await requireAdmin();
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("NOT_FOUND");

    const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    try {
      if (parsed.data.action === "start") {
        return ok({
          job: await startFineTuneJob(userRow.tenant_id, user.id, params.data.id),
        });
      }
      return ok({
        result: await activateFineTunedModel(userRow.tenant_id, user.id, params.data.id),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (["NOT_FOUND", "NO_MODEL"].includes(message)) throw new AppError("NOT_FOUND");
      if (message === "NO_APPROVED_EXAMPLES") {
        throw new AppError("VALIDATION_FAILED", "No hay ejemplos aprobados para entrenar.");
      }
      if (message === "JOB_NOT_STARTABLE") {
        throw new AppError("VALIDATION_FAILED", "Este trabajo ya fue iniciado.");
      }
      if (message === "JOB_NOT_APPROVABLE") {
        throw new AppError("VALIDATION_FAILED", "Este trabajo todavÃ­a no estÃ¡ listo para aprobar.");
      }
      if (message === "JOB_NOT_APPROVED") {
        throw new AppError("VALIDATION_FAILED", "AprobÃ¡ la evaluaciÃ³n antes de activar el modelo.");
      }
      throw e;
    }
  } catch (e) {
    return err(e);
  }
}
