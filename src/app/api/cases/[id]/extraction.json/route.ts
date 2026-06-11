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
 * RLS scopes the tenant; wrong-tenant case → 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
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
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return err(new AppError("MISSING_SESSION"));

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

    // ── 4. Case (RLS-scoped — IDOR-safe 404) ─────────────────────────────────
    const { data: caseRow } = await (supabase as any)
      .from("cases")
      .select("id,tenant_id,claim_type,status")
      .eq("id", caseId)
      .maybeSingle();
    if (!caseRow) {
      return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
    }

    // ── 5. Latest agent run for THIS case (fresh, never another email's) ─────
    const run = await getLatestAgentRun(supabase as any, caseId);
    if (!run) {
      return err(
        new AppError(
          "NOT_FOUND",
          "No hay extracción del agente registrada para este caso."
        )
      );
    }

    // Current (analyst-corrected) extracted values complement the raw output.
    const { data: extractedFields } = await (supabase as any)
      .from("extracted_fields")
      .select("field_key,field_value,confidence,extracted_at")
      .eq("case_id", caseId);

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
      confirmed_extracted_fields: extractedFields ?? [],
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
