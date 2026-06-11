/**
 * GET /api/cases/:id/agent-run — latest agent run + live extraction data for
 * the case preview panel.
 *
 * Fixes the "preview values not loading" bug: the panel fetches this endpoint
 * client-side with cache: 'no-store' keyed by case id, so it always reflects
 * the CURRENT case (no stale router-cache payloads from another email) and it
 * can poll while the case is still 'procesando' (extraction in flight).
 *
 * Auth: any authenticated role (viewers may inspect). RLS scopes the tenant;
 * wrong-tenant case → 404 (never 403 — no tenant enumeration).
 *
 * Response:
 *   {
 *     case_status, is_claim,
 *     run: AgentRunRow | null,   // includes input email, raw output JSON,
 *                                // confidence payload, trainability
 *     extracted_fields: [...],   // current (analyst-corrected) values
 *     missing_docs: [...],
 *     pending_confirmations: [...],
 *     already_approved: boolean  // training example exists for this run
 *   }
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { getLatestAgentRun } from "@/server/training/agent-runs";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

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
      buildUserKey(user.id, "agent-run"),
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

    // ── 4. Case (RLS-scoped → wrong tenant = no row = 404) ───────────────────
    const { data: caseRow } = await (supabase as any)
      .from("cases")
      .select("id,status,is_claim")
      .eq("id", caseId)
      .maybeSingle();
    if (!caseRow) {
      return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
    }

    // ── 5. Latest run + current extraction state, in parallel ────────────────
    const [run, fieldsResult, missingResult, confirmationsResult] =
      await Promise.all([
        getLatestAgentRun(supabase as any, caseId),
        (supabase as any)
          .from("extracted_fields")
          .select("field_key,field_value,confidence,extracted_at")
          .eq("case_id", caseId)
          .order("field_key", { ascending: true }),
        (supabase as any)
          .from("missing_docs")
          .select("doc_key,satisfied_at")
          .eq("case_id", caseId)
          .is("satisfied_at", null),
        (supabase as any)
          .from("claim_field_confirmations")
          .select("field_key,proposed_value,confidence,status")
          .eq("case_id", caseId)
          .eq("status", "pending"),
      ]);

    // ── 6. Already approved? ─────────────────────────────────────────────────
    let alreadyApproved = false;
    if (run) {
      const { data: existing } = await (supabase as any)
        .from("training_examples")
        .select("id")
        .eq("agent_run_id", run.id)
        .limit(1)
        .maybeSingle();
      alreadyApproved = Boolean(existing);
    }

    return ok({
      case_status: caseRow.status,
      is_claim: caseRow.is_claim,
      run,
      extracted_fields: fieldsResult?.data ?? [],
      missing_docs: missingResult?.data ?? [],
      pending_confirmations: confirmationsResult?.data ?? [],
      already_approved: alreadyApproved,
    });
  } catch (e) {
    return err(e);
  }
}
