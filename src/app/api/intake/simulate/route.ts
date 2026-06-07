/**
 * POST /api/intake/simulate — simulate an inbound email claim.
 *
 * AC4: Returns 202 immediately with {case_id, status: "procesando"}.
 *       Creates case + raw_messages row. Triggers AI extraction worker async.
 * LLM10 (budget guard): Returns 429 with code AI_BUDGET_EXCEEDED when any budget
 *       cap (per-user, per-tenant, or monthly) is exceeded. Fail-closed per spec.
 * AC17: LLM prompt injection contained via XML sentinels in prompt.ts.
 *
 * Rate limit: 30/min per user (INTAKE_SIMULATE config).
 * Auth: required (analyst or admin role).
 *
 * Body modes:
 *   { scenario_id: "choque-01" }          → use pre-seeded scenario
 *   { raw_text: "...", case_type: "robo" } → ad-hoc text
 */

import { type NextRequest, after } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { SimulateIntakeSchema } from "@/lib/schemas/intake";
import { getScenarioById } from "@/server/intake/scenarios";
import { runExtractionWorker } from "@/server/worker/extract";
import { checkBudget } from "@/server/ai/budget";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { accepted, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
  getClientIp,
} from "@/lib/rate-limit/index";
import type { Database } from "@/lib/supabase/types";
import type { ClaimType } from "@/lib/schemas/cases";

type UserRow = Database["public"]["Tables"]["users"]["Row"];

function scheduleAfterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    const code = (err as { __NEXT_ERROR_CODE?: string })?.__NEXT_ERROR_CODE;
    if (code === "E468" || message.includes("outside a request scope")) {
      void task();
      return;
    }
    throw err;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  // ── 1. Auth ─────────────────────────────────────────────────────────────────
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return err(new AppError("MISSING_SESSION"));
  }

   
  const { data: userRowRaw } = await (supabase as any)
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  const userRow = userRowRaw as UserRow | null;
  if (!userRow) {
    return err(new AppError("MISSING_SESSION"));
  }

  // ── 2. Rate limit ────────────────────────────────────────────────────────────
  const ip = getClientIp(request);
  const rlKey = buildUserKey(userRow.id, "intake-simulate");
  const rlResult = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.INTAKE_SIMULATE);

  if (!rlResult.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          code: "RATE_LIMITED",
          message: "Demasiadas solicitudes. Esperá un momento.",
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(rlResult.retryAfterSeconds),
        },
      }
    );
  }

  // ── 3. Validate body ─────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err(new AppError("VALIDATION_FAILED", "El cuerpo de la solicitud no es JSON válido."));
  }

  const parsed = SimulateIntakeSchema.safeParse(body);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        parsed.error.issues[0]?.message ?? "Datos de entrada inválidos.",
        parsed.error.flatten()
      )
    );
  }

  const input = parsed.data;

  // ── 4. Resolve scenario or raw text ─────────────────────────────────────────
  let rawText: string;
  let claimType: ClaimType;
  let policyholderName: string | null = null;
  let policyNumber: string | null = null;

  if (input.scenario_id) {
    const scenario = getScenarioById(input.scenario_id);
    if (!scenario) {
      return err(
        new AppError(
          "VALIDATION_FAILED",
          `ID de escenario inválido: ${input.scenario_id}.`
        )
      );
    }
    rawText = scenario.raw_text;
    claimType = scenario.case_type;
    policyholderName = scenario.policyholder_name;
    policyNumber = scenario.policy_number;
  } else {
    rawText = input.raw_text!;
    claimType = input.case_type!;
  }

  // ── 5. Budget guard ──────────────────────────────────────────────────────────
  const budgetResult = await checkBudget(userRow.tenant_id, userRow.id);
  if (budgetResult.exceeded) {
    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: userRow.id,
      event_type: AuditEvent.AI_BUDGET_EXCEEDED,
      target_type: null,
      target_id: null,
      payload: { reason: budgetResult.reason },
      ip,
      ua: request.headers.get("user-agent") ?? undefined,
    });
    return new Response(
      JSON.stringify({
        error: {
          code: "AI_BUDGET_EXCEEDED",
          message: "Presupuesto de IA agotado para este mes.",
          details: { reason: budgetResult.reason },
        },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── 6. Create case + raw_message in DB (service role for reliability) ────────
  const serviceSupabase = createServiceClient();

   
  const { data: newCase, error: caseError } = await (serviceSupabase as any)
    .from("cases")
    .insert({
      tenant_id: userRow.tenant_id,
      policy_number: policyNumber,
      policyholder_name: policyholderName,
      claim_type: claimType,
      status: "procesando",
      confidence_min: null,
      assigned_to: userRow.id,
      channel: "email_sim",
    })
    .select("id")
    .single();

  if (caseError || !newCase) {
    console.error("[intake/simulate] Failed to create case:", caseError?.code);
    return err(new AppError("INTERNAL_ERROR"));
  }

  const caseId = (newCase as { id: string }).id;

  // Create raw_message row (stores full email body verbatim — PII stored, never logged).
   
  const { error: rawMsgError } = await (serviceSupabase as any).from("raw_messages").insert({
    case_id: caseId,
    tenant_id: userRow.tenant_id,
    channel: "email_sim",
    from_addr: policyholderName ? `${policyholderName.toLowerCase().replace(/\s+/g, ".")}@example.com` : null,
    subject: `[email_sim] Siniestro - ${claimType} - ${input.scenario_id ?? "custom"}`,
    body: rawText,
  });

  if (rawMsgError) {
    console.error("[intake/simulate] Failed to create raw_message:", rawMsgError.code);
    // Non-fatal — case still created; worker will fail gracefully.
  }

  // Audit log: case created.
  await writeAuditLog({
    tenant_id: userRow.tenant_id,
    actor_id: userRow.id,
    event_type: AuditEvent.CASE_CREATED,
    target_type: "case",
    target_id: caseId,
    payload: {
      claim_type: claimType,
      channel: "email_sim",
      scenario_id: input.scenario_id ?? null,
    },
    ip,
    ua: request.headers.get("user-agent") ?? undefined,
  });

  // ── 7. Trigger extraction worker after response is sent ──────────────────────
  // after() keeps the Vercel function alive until the worker finishes.
  scheduleAfterResponse(async () => {
    try {
      await runExtractionWorker(caseId, userRow.tenant_id, userRow.id);
    } catch (e: unknown) {
      const name = e instanceof Error ? e.name : "UnknownError";
      console.error("[intake/simulate] Worker error:", name, "case:", caseId);
    }
  });

  // ── 8. Return 202 immediately ─────────────────────────────────────────────────
  return accepted({
    case_id: caseId,
    status: "procesando",
    message: "Procesando...",
  });
}
