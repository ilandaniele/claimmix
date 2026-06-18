/**
 * GET /api/admin/fine-tuning/jobs/:id/export?kind=train|validation
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { tables } from "@/lib/db";
import { err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { db, userRow } = await requireAdmin();
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("NOT_FOUND");
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") === "validation" ? "validation" : "train";

    const t = tables.modelTrainingJobs;
    const [job] = await db
      .select({ training_jsonl: t.training_jsonl, validation_jsonl: t.validation_jsonl })
      .from(t)
      .where(and(eq(t.id, params.data.id), eq(t.tenant_id, userRow.tenant_id)))
      .limit(1);
    if (!job) throw new AppError("NOT_FOUND");

    const content = kind === "validation" ? job.validation_jsonl : job.training_jsonl;
    if (!content) throw new AppError("NOT_FOUND");

    return new NextResponse(content, {
      headers: {
        "content-type": "application/jsonl; charset=utf-8",
        "content-disposition": `attachment; filename="claimmix-${params.data.id}-${kind}.jsonl"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return err(e);
  }
}
