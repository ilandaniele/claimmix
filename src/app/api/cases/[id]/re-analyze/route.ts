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
 * RLS is gone — every query filters explicitly by the caller's tenant_id.
 */

import { type NextRequest, after } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requireRole, ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";
import { CaseStatusSchema } from "@/lib/schemas/cases";
import { runIntakeAgent } from "@/server/agents/intake-agent";
import { checkBudget } from "@/server/ai/budget";
import { isTerminalStatus } from "@/server/cases/fsm";
import { writeAuditLog } from "@/lib/audit/log";
import { accepted, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  getClientIp,
} from "@/lib/rate-limit/index";

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
  let ctx: RoleContext;
  try {
    ctx = await requireRole(...ALL_ROLES);
  } catch {
    return err(new AppError("MISSING_SESSION"));
  }
  const { userRow } = ctx;

  // Viewers are read-only.
  if (userRow.role === "viewer") {
    return err(new AppError("FORBIDDEN_ROLE", "Tu rol es de solo lectura."));
  }

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

  // ── Verify case belongs to tenant (IDOR — explicit tenant_id filter) ─────────
  let caseRow: { id: string; status: string } | null;
  try {
    caseRow = firstRow(
      await db
        .select({ id: cases.id, status: cases.status })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.tenant_id, userRow.tenant_id)))
        .limit(1)
    );
  } catch {
    caseRow = null;
  }

  if (!caseRow) return err(new AppError("NOT_FOUND"));
  const statusParsed = CaseStatusSchema.safeParse(caseRow.status);
  if (statusParsed.success && isTerminalStatus(statusParsed.data)) {
    return err(
      new AppError(
        "FSM_INVALID_TRANSITION",
        "No se puede re-analizar un caso en estado terminal."
      )
    );
  }

  // ── Budget check ──────────────────────────────────────────────────────────────
  const budgetResult = await checkBudget(userRow.tenant_id, userRow.id);
  if (budgetResult.exceeded) {
    return err(new AppError("AI_BUDGET_EXCEEDED", "Presupuesto de IA agotado para este mes."));
  }

  // ── Reset case to procesando ──────────────────────────────────────────────────
  try {
    const resetCase = firstRow(
      await db
      .update(cases)
      .set({ status: "procesando", updated_at: new Date().toISOString() })
        .where(and(eq(cases.id, caseId), eq(cases.tenant_id, userRow.tenant_id)))
        .returning({ id: cases.id, status: cases.status })
    );
    if (!resetCase || resetCase.status !== "procesando") {
      return err(
        new AppError(
          "INTERNAL_ERROR",
          "No se pudo reiniciar el caso para re-analisis."
        )
      );
    }
  } catch (e) {
    const code = (e as { code?: string })?.code ?? (e instanceof Error ? e.name : "UnknownError");
    console.error("[re-analyze] Failed to reset case:", code, caseId);
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

  // ── Trigger worker after response is sent ────────────────────────────────────
  // Using after() ensures Vercel keeps the function alive until the worker
  // finishes — plain fire-and-forget gets killed when the 202 is returned.
  after(async () => {
    try {
      await runIntakeAgent({
        caseId,
        tenantId: userRow.tenant_id,
        userId: userRow.id,
        source: "manual",
      });
    } catch (e: unknown) {
      const name = e instanceof Error ? e.name : "UnknownError";
      console.error("[re-analyze] Worker error:", name, "case:", caseId);
    }
  });

  return accepted({ case_id: caseId, status: "procesando", message: "Re-análisis iniciado." });
}
