/**
 * POST /api/cases/:id/re-analyze — re-run AI extraction worker on a case.
 *
 * Rate limit: 5/hr/case (to prevent cost abuse from re-triggering).
 * Auth: required (analyst or admin).
 *
 * FSM: Case must be in a non-terminal, non-procesando state to allow re-analysis.
 *      Re-analysis temporarily sets status to "procesando" then the worker transitions it.
 *
 * LLM10: Budget check before running extractor.
 */

import { type NextRequest } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { runExtractionWorker } from "@/server/worker/extract";
import { checkBudget } from "@/server/ai/budget";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { accepted, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  getClientIp,
} from "@/lib/rate-limit/index";
import type { Database } from "@/lib/supabase/types";

type UserRow = Database["public"]["Tables"]["users"]["Row"];

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
});

// Rate limit: 5 re-analyses per hour per case.
const RE_ANALYZE_LIMIT = { limit: 5, windowMs: 3_600_000 };

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const rawParams = await context.params;
  const paramsParsed = ParamsSchema.safeParse(rawParams);
  if (!paramsParsed.success) {
    return err(new AppError("VALIDATION_FAILED", paramsParsed.error.issues[0]?.message));
  }
  const caseId = paramsParsed.data.id;

  // ── Auth ─────────────────────────────────────────────────────────────────────
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return err(new AppError("MISSING_SESSION"));

   
  const { data: userRowRaw } = await (supabase as any)
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  const userRow = userRowRaw as UserRow | null;
  if (!userRow) return err(new AppError("MISSING_SESSION"));

  // ── Rate limit per case ───────────────────────────────────────────────────────
  const ip = getClientIp(request);
  const rlKey = `re-analyze:${caseId}:${userRow.id}`;
  const rlResult = await rateLimit(rlKey, RE_ANALYZE_LIMIT);
  if (!rlResult.allowed) {
    return new Response(
      JSON.stringify({
        error: { code: "RATE_LIMITED", message: "Demasiados re-análisis para este caso. Esperá una hora." },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(rlResult.retryAfterSeconds) },
      }
    );
  }

  // ── Verify case belongs to tenant (IDOR) ─────────────────────────────────────
   
  const { data: caseRow } = await (supabase as any)
    .from("cases")
    .select("id,status,tenant_id")
    .eq("id", caseId)
    .single();

  if (!caseRow) return err(new AppError("NOT_FOUND"));
  if (caseRow.status === "cerrado") {
    return err(new AppError("FSM_INVALID_TRANSITION", "No se puede re-analizar un caso cerrado."));
  }

  // ── Budget check ──────────────────────────────────────────────────────────────
  const budgetResult = await checkBudget(userRow.tenant_id, userRow.id);
  if (budgetResult.exceeded) {
    return err(new AppError("AI_BUDGET_EXCEEDED", "Presupuesto de IA agotado para este mes."));
  }

  // ── Reset case to procesando ──────────────────────────────────────────────────
  const serviceSupabase = createServiceClient();
   
  const { error: resetError } = await (serviceSupabase as any)
    .from("cases")
    .update({ status: "procesando", updated_at: new Date().toISOString() })
    .eq("id", caseId);

  if (resetError) {
    console.error("[re-analyze] Failed to reset case:", resetError.code, caseId);
    return err(new AppError("INTERNAL_ERROR"));
  }

  await writeAuditLog({
    tenant_id: userRow.tenant_id,
    actor_id: userRow.id,
    event_type: "case.re_analyze_triggered",
    target_type: "case",
    target_id: caseId,
    payload: { previous_status: caseRow.status },
    ip,
    ua: request.headers.get("user-agent") ?? undefined,
  });

  // ── Trigger worker async ──────────────────────────────────────────────────────
  const workerPromise = runExtractionWorker(caseId, userRow.tenant_id, userRow.id);
  workerPromise.catch((e: unknown) => {
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error("[re-analyze] Worker error:", name, "case:", caseId);
  });

  return accepted({ case_id: caseId, status: "procesando", message: "Re-análisis iniciado." });
}
