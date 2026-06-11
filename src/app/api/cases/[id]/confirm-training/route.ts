/**
 * POST /api/cases/:id/confirm-training — "Confirmar como ejemplo de
 * entrenamiento seguro" (Confirm as safe training example).
 *
 * THE ONLY WAY the agent learns from an email. Until this endpoint is called
 * by a human, every incoming email is untrusted and never used for training.
 *
 * Auth: owner / admin / specialist only (TRAINING_APPROVER_ROLES).
 * Body: { agent_run_id?: uuid } — defaults to the latest run for the case.
 *
 * Behavior:
 *   - Approves the run as a training_examples row (status='approved').
 *   - expected_output includes analyst-corrected extracted_fields.
 *   - Duplicates rejected (unique per agent_run / claim_message) → 409-like 400.
 *   - Unsafe runs (invalid JSON / suspected prompt injection) always refused.
 *   - Audit event TRAINING_EXAMPLE_APPROVED written.
 *   - May create a DRAFT model_training_jobs row when the batch threshold is
 *     reached — fine-tuning is batched and never automatic.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, TRAINING_APPROVER_ROLES } from "@/lib/auth/require-role";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { approveTrainingExample } from "@/server/training/examples";
import { getLatestAgentRun } from "@/server/training/agent-runs";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";

const ParamsSchema = z.object({ id: z.string().uuid() });

const BodySchema = z.object({
  agent_run_id: z.string().uuid().optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // ── 1. Auth + role (only admin/specialist/owner can confirm training) ───
    const { supabase, user, userRow } = await requireRole(
      ...TRAINING_APPROVER_ROLES
    );

    // ── 2. Rate limit ────────────────────────────────────────────────────────
    const rl = await rateLimit(
      buildUserKey(user.id, "confirm-training"),
      RATE_LIMIT_CONFIGS.CASES_API
    );
    if (!rl.allowed) return err(new AppError("RATE_LIMITED"));

    // ── 3. Params + body ─────────────────────────────────────────────────────
    const rawParams = await context.params;
    const parsedParams = ParamsSchema.safeParse(rawParams);
    if (!parsedParams.success) {
      return err(new AppError("NOT_FOUND", "El caso no existe."));
    }
    const caseId = parsedParams.data.id;

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // Empty body is fine — agent_run_id defaults to the latest run.
    }
    const parsedBody = BodySchema.safeParse(body ?? {});
    if (!parsedBody.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsedBody.error.flatten());
    }

    // ── 4. IDOR check — case must exist within the user's tenant (RLS) ───────
    const { data: caseRow } = await (supabase as any)
      .from("cases")
      .select("id")
      .eq("id", caseId)
      .maybeSingle();
    if (!caseRow) {
      return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
    }

    // ── 5. Resolve the agent run ─────────────────────────────────────────────
    let agentRunId = parsedBody.data.agent_run_id ?? null;
    if (!agentRunId) {
      const latest = await getLatestAgentRun(supabase as any, caseId);
      agentRunId = latest?.id ?? null;
    }
    if (!agentRunId) {
      return err(
        new AppError(
          "NOT_FOUND",
          "No hay ejecución del agente registrada para este caso."
        )
      );
    }

    // ── 6. Approve (RLS-scoped client — tenant isolation enforced by DB) ─────
    const result = await approveTrainingExample(supabase as any, {
      tenantId: userRow.tenant_id,
      agentRunId,
      approvedBy: user.id,
    });

    if (!result.ok) {
      switch (result.reason) {
        case "run_not_found":
          return err(new AppError("NOT_FOUND", "La ejecución del agente no existe."));
        case "duplicate":
          return err(
            new AppError(
              "VALIDATION_FAILED",
              "Este email ya fue confirmado como ejemplo de entrenamiento."
            )
          );
        case "unsafe_run":
          return err(
            new AppError(
              "VALIDATION_FAILED",
              "Esta ejecución no es segura para entrenamiento (JSON inválido o posible inyección de prompt)."
            )
          );
        default:
          return err(new AppError("INTERNAL_ERROR"));
      }
    }

    return ok(
      {
        training_example_id: result.exampleId,
        agent_run_id: agentRunId,
        queued_finetune_job_id: result.queuedFineTuneJobId,
      },
      201
    );
  } catch (e) {
    return err(e);
  }
}
