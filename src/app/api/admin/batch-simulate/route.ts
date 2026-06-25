/**
 * POST /api/admin/batch-simulate — run N simulations server-side sequentially.
 *
 * Solves the "tab freezing" training problem: instead of requiring the admin's
 * browser tab to be open while a script loops through simulations, this endpoint
 * accepts a batch count and runs all simulations inside a single server-side
 * after() callback — no browser dependency.
 *
 * Body: { count: 1–50, delay_ms?: 0–5000, claim_type?: ClaimType, scenario_id?: string }
 *
 * Returns 202 immediately with { accepted: N, case_ids: [...] }.
 * After the response, processes all cases sequentially with the specified delay.
 *
 * Admin-only. Rate limited to 2 batch jobs / 10 min per user.
 */

import { type NextRequest, after } from "next/server";
import { z } from "zod";
import { firstRow } from "@/lib/db/helpers";
import { cases, rawMessages } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/require-admin";
import { ClaimTypeSchema } from "@/lib/schemas/cases";
import { getRandomScenario, getScenarioById } from "@/server/intake/scenarios";
import { runIntakeAgent } from "@/server/agents/intake-agent";
import { checkBudget } from "@/server/ai/budget";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { accepted, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { rateLimit, getClientIp } from "@/lib/rate-limit/index";
import type { ClaimType } from "@/lib/schemas/cases";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const BatchSimulateSchema = z.object({
  count: z.number().int().min(1).max(50),
  delay_ms: z.number().int().min(0).max(5_000).default(1_500),
  claim_type: ClaimTypeSchema.optional(),
  scenario_id: z.string().max(80).optional(),
});

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const { db: adminDb, user, userRow } = await requireAdmin();

    const ip = getClientIp(request);
    const rlKey = `batch-simulate:${userRow.id}`;
    const rlResult = await rateLimit(rlKey, { limit: 2, windowMs: 600_000 });
    if (!rlResult.allowed) {
      return err(new AppError("RATE_LIMITED", "Máximo 2 lotes cada 10 minutos."));
    }

    const parsed = BatchSimulateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { count, delay_ms, claim_type, scenario_id } = parsed.data;

    const budgetResult = await checkBudget(userRow.tenant_id, userRow.id);
    if (budgetResult.exceeded) {
      throw new AppError("AI_BUDGET_EXCEEDED", "Presupuesto de IA agotado para este mes.");
    }

    // ── Create all N cases synchronously ───────────────────────────────────────
    const caseIds: string[] = [];

    // Resolve a fixed scenario if scenario_id is supplied; otherwise pick randomly each iteration.
    const fixedScenario = scenario_id ? getScenarioById(scenario_id) : undefined;
    if (scenario_id && !fixedScenario) {
      throw new AppError("VALIDATION_FAILED", `ID de escenario inválido: ${scenario_id}.`);
    }

    for (let i = 0; i < count; i++) {
      const scenario = fixedScenario ?? getRandomScenario(claim_type);

      const rawText = scenario.raw_text;
      const finalClaimType: ClaimType = scenario.case_type;
      const policyholderName = scenario.policyholder_name;
      const policyNumber = scenario.policy_number;

      try {
        const newCase = firstRow(
          await adminDb
            .insert(cases)
            .values({
              tenant_id: userRow.tenant_id,
              policy_number: policyNumber,
              policyholder_name: policyholderName,
              claim_type: finalClaimType,
              status: "procesando",
              confidence_min: null,
              assigned_to: userRow.id,
              channel: "email_sim",
            })
            .returning({ id: cases.id, created_at: cases.created_at })
        );

        if (!newCase) continue;
        caseIds.push(newCase.id);

        await adminDb.insert(rawMessages).values({
          case_id: newCase.id,
          tenant_id: userRow.tenant_id,
          channel: "email_sim",
          from_addr: policyholderName
            ? `${policyholderName.toLowerCase().replace(/\s+/g, ".")}@example.com`
            : null,
          subject: `[batch_sim] Siniestro - ${finalClaimType} - ${scenario.id}`,
          body: rawText,
        }).catch(() => undefined);
      } catch {
        // skip individual case creation failures
      }
    }

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type: AuditEvent.CASE_CREATED,
      target_type: null,
      target_id: null,
      payload: {
        batch: true,
        requested: count,
        accepted: caseIds.length,
        claim_type: claim_type ?? null,
        delay_ms,
      },
      ip,
      ua: request.headers.get("user-agent") ?? undefined,
    });

    // ── Process all cases sequentially in after() — runs after response ────────
    const tenantId = userRow.tenant_id;
    const userId = userRow.id;
    const capturedIds = [...caseIds];
    const capturedDelay = delay_ms;

    after(async () => {
      for (const caseId of capturedIds) {
        try {
          await runIntakeAgent({ caseId, tenantId, userId, source: "simulate" });
        } catch (e) {
          const name = e instanceof Error ? e.name : "UnknownError";
          console.error("[batch-simulate] worker error:", name, "case:", caseId);
        }
        if (capturedDelay > 0) await sleep(capturedDelay);
      }
      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: "batch_simulate.complete",
          tenant_id: tenantId,
          processed: capturedIds.length,
        })
      );
    });

    return accepted({
      accepted: caseIds.length,
      case_ids: caseIds,
      message: `${caseIds.length} simulaciones en cola. Se procesarán en segundo plano.`,
    });
  } catch (e) {
    return err(e);
  }
}
