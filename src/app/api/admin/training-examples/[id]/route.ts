/**
 * /api/admin/training-examples/:id - update training example status.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { requireAdmin } from "@/lib/auth/require-admin";
import { tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const PatchSchema = z.object({ status: z.enum(["approved", "rejected"]) });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { db, user, userRow } = await requireAdmin();
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("NOT_FOUND");
    const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const t = tables.trainingExamples;
    const example = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .update(t)
          .set({
            status: parsed.data.status,
            approved_by: parsed.data.status === "approved" ? user.id : null,
            approved_at: parsed.data.status === "approved" ? new Date().toISOString() : null,
          })
          .where(eq(t.id, params.data.id))
          .returning({ id: t.id, case_id: t.case_id, status: t.status })
      )
    );

    if (!example) throw new AppError("NOT_FOUND");

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type:
        parsed.data.status === "approved"
          ? AuditEvent.TRAINING_EXAMPLE_APPROVED
          : AuditEvent.TRAINING_EXAMPLE_REJECTED,
      target_type: "case",
      target_id: example.case_id,
      payload: { training_example_id: example.id, status: example.status },
    });

    return ok({ example });
  } catch (e) {
    return err(e);
  }
}
