/**
 * GET /api/cases/:id/extraction.json — "Descargar JSON extraído".
 *
 * Downloads the full agent extraction output for the case's LATEST agent run
 * (always fetched fresh — never cached/stale data from another email).
 *
 * File: claim-extraction-{caseId}-{messageId}.json (safe filename — both ids
 * are UUIDs/sanitized, no user-controlled text).
 *
 * Auth: any authenticated role (viewers can inspect extracted JSON).
 * Explicit tenant_id filters scope the tenant (RLS is gone);
 * wrong-tenant case → 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requireRole, ALL_ROLES } from "@/lib/auth/require-role";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { cases, extractedFields } from "@/lib/db/schema";
import { err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { getLatestAgentRun } from "@/server/training/agent-runs";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** Strip anything that is not [a-zA-Z0-9-] — belt and suspenders for the filename. */
function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) || "unknown";
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // ── 1. Auth ──────────────────────────────────────────────────────────────
    const { user, userRow } = await requireRole(...ALL_ROLES);
    const tenantId = userRow.tenant_id;
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: tenantId };

    // ── 2. Rate limit ────────────────────────────────────────────────────────
    const rl = await rateLimit(
      buildUserKey(user.id, "extraction-download"),
      RATE_LIMIT_CONFIGS.CASES_API
    );
    if (!rl.allowed) return err(new AppError("RATE_LIMITED"));

    // ── 3. Params ────────────────────────────────────────────────────────────
    const rawParams = await context.params;
    const parsed = ParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      return err(new AppError("NOT_FOUND", "El caso no existe."));
    }
    const caseId = parsed.data.id;

    // ── 4. Case (explicit tenant filter — IDOR-safe 404) ─────────────────────
    const caseRow = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({
            id: cases.id,
            tenant_id: cases.tenant_id,
            claim_type: cases.claim_type,
            status: cases.status,
          })
          .from(cases)
          .where(eq(cases.id, caseId))
          .limit(1)
      )
    );
    if (!caseRow) {
      return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
    }

    // ── 5. Latest agent run for THIS case (fresh, never another email's) ─────
    const run = await getLatestAgentRun(tenantId, caseId);
    if (!run) {
      return err(
        new AppError(
          "NOT_FOUND",
          "No hay extracción del agente registrada para este caso."
        )
      );
    }

    // Current (analyst-corrected) extracted values complement the raw output.
    const fieldRows = await enTenant(tenantCtx, (db) =>
      db
        .select({
          field_key: extractedFields.field_key,
          field_value: extractedFields.field_value,
          confidence: extractedFields.confidence,
          extracted_at: extractedFields.extracted_at,
        })
        .from(extractedFields)
        .where(
          eq(extractedFields.case_id, caseId)
        )
        .catch(() => [])
    );

    const output = run.output_payload ?? ({} as Record<string, unknown>);

    const payload = {
      claim_id: caseId,
      message_id: run.claim_message_id ?? run.provider_message_id ?? null,
      tenant_id: caseRow.tenant_id,
      model_provider: run.model_provider,
      model_name: run.model_name,
      prompt_version: run.prompt_version,
      extracted_fields: (output as { extracted_fields?: unknown }).extracted_fields ?? null,
      fields: (output as { fields?: unknown }).fields ?? [],
      confidence_scores: run.confidence_payload ?? {},
      missing_fields: run.missing_fields ?? [],
      fields_pending_confirmation:
        (output as { fields_pending_confirmation?: unknown }).fields_pending_confirmation ?? [],
      trainability: {
        is_trainable_suggestion: run.is_trainable_suggestion,
        trainability_score: run.trainability_score,
        trainability_reasons: run.trainability_reasons,
        blocking_reasons: run.blocking_reasons,
      },
      // numeric → string under Drizzle; convert to preserve the JSON shape.
      confirmed_extracted_fields: fieldRows.map((f) => ({
        ...f,
        confidence: Number(f.confidence),
      })),
      raw_agent_output: output,
      created_at: run.created_at,
    };

    const fileCaseId = sanitizeForFilename(caseId);
    const fileMessageId = sanitizeForFilename(
      String(run.claim_message_id ?? run.provider_message_id ?? "sin-mensaje")
    );
    const filename = `claim-extraction-${fileCaseId}-${fileMessageId}.json`;

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return err(e);
  }
}
