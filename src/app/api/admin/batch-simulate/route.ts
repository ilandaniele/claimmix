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
import { reapStuckProcessingCases } from "@/server/intake/reap-stuck";
import { checkBudget } from "@/server/ai/budget";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { accepted, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { rateLimit, getClientIp } from "@/lib/rate-limit/index";
import type { ClaimType } from "@/lib/schemas/cases";
import { internalAuthHeaders, isInternalRequest } from "@/lib/security/internal-auth";
import { getWorkerBaseUrl } from "@/server/email/dispatch-url";
import { BATCH_BUDGET_MS, MAX_CHAIN, fitsAnotherCase } from "@/server/intake/batch-budget";
import { enTenant } from "@/data/scope";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BatchSimulateSchema = z.object({
  count: z.number().int().min(1).max(50),
  delay_ms: z.number().int().min(0).max(5_000).default(1_500),
  claim_type: ClaimTypeSchema.optional(),
  scenario_id: z.string().max(80).optional(),
});

/**
 * La continuación: los casos que la invocación anterior no llegó a procesar.
 *
 * Entra por la misma ruta y no por una nueva porque es el mismo trabajo, sólo
 * que ya con los casos creados. Se autentica con CRON_SECRET —la manda el
 * deploy a sí mismo— y por eso no pasa por requireAdmin ni por el limitador:
 * la persona ya fue autorizada cuando pidió el lote.
 */
const ContinuationSchema = z.object({
  continue_case_ids: z.array(z.string().uuid()).min(1).max(50),
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid().nullable().optional(),
  delay_ms: z.number().int().min(0).max(5_000).default(1_500),
  chain: z.number().int().min(1).max(MAX_CHAIN),
});

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Procesa lo que entre en esta invocación y le pasa el resto a la siguiente.
 *
 * El lote se procesa en serie porque las extracciones simuladas se turnan; lo
 * que no se puede es que todas tengan que entrar en la misma invocación. Antes
 * de cada caso se pregunta si alcanza el tiempo para uno más, midiendo lo que
 * costaron los anteriores. Cuando no alcanza, lo que queda viaja a otra
 * invocación por HTTP, con el secreto interno.
 *
 * Sin esto la invocación se cortaba a mitad de camino y los casos que faltaban
 * quedaban en `procesando` hasta que el reaper los escalaba al día siguiente.
 */
async function processBatch(input: {
  caseIds: string[];
  tenantId: string;
  userId: string | null;
  delayMs: number;
  chain: number;
}): Promise<void> {
  const startedAt = Date.now();
  const pending = [...input.caseIds];
  let processed = 0;

  while (pending.length > 0) {
    if (!fitsAnotherCase(Date.now() - startedAt, processed, BATCH_BUDGET_MS)) break;

    const caseId = pending.shift()!;
    try {
      await runIntakeAgent({
        caseId,
        tenantId: input.tenantId,
        userId: input.userId,
        source: "simulate",
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "UnknownError";
      console.error("[batch-simulate] worker error:", name, "case:", caseId);
    }
    processed++;
    if (input.delayMs > 0 && pending.length > 0) await sleep(input.delayMs);
  }

  console.info(
    JSON.stringify({
      level: "info",
      service: "claimmix",
      msg: "batch_simulate.slice_complete",
      tenant_id: input.tenantId,
      chain: input.chain,
      processed,
      pending: pending.length,
      elapsed_ms: Date.now() - startedAt,
    })
  );

  if (pending.length === 0) return;

  // Un tope de eslabones, no porque se espere llegar —seis por lo que entra en
  // cada uno cubre de sobra el máximo de 50— sino porque una cadena sin tope es
  // una función que se llama a sí misma contra la tarjeta de alguien.
  if (input.chain >= MAX_CHAIN) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "batch_simulate.chain_exhausted",
        tenant_id: input.tenantId,
        abandoned: pending.length,
      })
    );
    return;
  }

  try {
    await fetch(`${getWorkerBaseUrl()}/api/admin/batch-simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalAuthHeaders() },
      body: JSON.stringify({
        continue_case_ids: pending,
        tenant_id: input.tenantId,
        user_id: input.userId,
        delay_ms: input.delayMs,
        chain: input.chain + 1,
      }),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error("[batch-simulate] no pude pasar el resto:", name, "quedan:", pending.length);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    // Un stream se lee una sola vez, así que el cuerpo se parsea acá y se usa
    // en las dos ramas. Leerlo de nuevo más abajo tira 'body already read', y
    // sólo pasaría con secreto interno Y sesión a la vez: donde peor se
    // encuentra un error.
    const body = await request.json().catch(() => null);

    // ── ¿Es la continuación de un lote que ya empezó? ─────────────────────
    //
    // Se mira antes que la sesión: la manda el propio deploy con el secreto
    // interno, no una persona, y los casos ya están creados. Se contesta rápido
    // y el trabajo sigue en after(), igual que el pedido original.
    if (isInternalRequest(request)) {
      const cont = ContinuationSchema.safeParse(body);
      if (cont.success) {
        const { continue_case_ids, tenant_id, user_id, delay_ms, chain } = cont.data;
        after(async () => {
          await processBatch({
            caseIds: continue_case_ids,
            tenantId: tenant_id,
            userId: user_id ?? null,
            delayMs: delay_ms,
            chain,
          });
        });
        return accepted({ accepted: continue_case_ids.length, case_ids: continue_case_ids, chain });
      }
    }

    const { user, userRow } = await requireAdmin();

    const ip = getClientIp(request);
    const rlKey = `batch-simulate:${userRow.id}`;
    const rlResult = await rateLimit(rlKey, { limit: 2, windowMs: 600_000 });
    if (!rlResult.allowed) {
      return err(new AppError("RATE_LIMITED", "Máximo 2 lotes cada 10 minutos."));
    }

    const parsed = BatchSimulateSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { count, delay_ms, claim_type, scenario_id } = parsed.data;

    const budgetResult = await checkBudget(userRow.tenant_id, userRow.id);
    if (budgetResult.exceeded) {
      throw new AppError("AI_BUDGET_EXCEEDED", "Presupuesto de IA agotado para este mes.");
    }

    // Clear cases stuck in `procesando` from a prior batch whose after() callbacks
    // were evicted — otherwise they linger and (briefly) crowd the throttle. This
    // runs synchronously in the request, so it works regardless of cron cadence.
    try {
      const reaped = await reapStuckProcessingCases({ tenantId: userRow.tenant_id });
      if (reaped.reaped > 0) {
        console.warn(`[batch-simulate] reaped ${reaped.reaped} stuck procesando case(s) before queuing`);
      }
    } catch {
      // never block a new batch on reaper failure
    }

    // ── Create all N cases synchronously ───────────────────────────────────────
    const caseIds: string[] = [];
    // Per-case creation failures, surfaced in the response so the caller can retry
    // the exact cases that failed instead of guessing from `accepted < requested`.
    const failedCases: Array<{
      index: number;
      scenario_id: string;
      claim_type: ClaimType;
      code: string | null;
    }> = [];

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
          await enTenant({ tenantId: userRow.tenant_id }, (db) =>
            db
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
          )
        );

        if (!newCase) {
          failedCases.push({
            index: i,
            scenario_id: scenario.id,
            claim_type: finalClaimType,
            code: "no_row",
          });
          continue;
        }
        caseIds.push(newCase.id);

        await enTenant({ tenantId: userRow.tenant_id }, (db) =>
          db.insert(rawMessages).values({
            case_id: newCase.id,
            tenant_id: userRow.tenant_id,
            channel: "email_sim",
            from_addr: policyholderName
              ? `${policyholderName.toLowerCase().replace(/\s+/g, ".")}@example.com`
              : null,
            subject: `[batch_sim] Siniestro - ${finalClaimType} - ${scenario.id}`,
            body: rawText,
          })
        ).catch(() => undefined);
      } catch (e) {
        // Skip this case but surface why — a silent catch here previously made
        // a broken cases INSERT look like `accepted: 0` with no explanation.
        const code = (e as { code?: string })?.code ?? null;
        failedCases.push({
          index: i,
          scenario_id: scenario.id,
          claim_type: finalClaimType,
          code,
        });
        console.error(
          "[batch-simulate] Failed to create case:",
          code,
          "claim_type:",
          finalClaimType,
          "scenario:",
          scenario.id
        );
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
        failed: failedCases.length,
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
      await processBatch({
        caseIds: capturedIds,
        tenantId,
        userId,
        delayMs: capturedDelay,
        chain: 1,
      });
    });

    return accepted({
      accepted: caseIds.length,
      case_ids: caseIds,
      failed: failedCases.length,
      failed_cases: failedCases,
      message: `${caseIds.length} simulaciones en cola. Se procesarán en segundo plano.`,
    });
  } catch (e) {
    return err(e);
  }
}
